import type { CogneeHttpOptions, CogneeRememberResult } from './cognee-http'

export interface DocumentPipelineState {
  datasetId: string
  dataIds: string[]
  terminal?: 'failed' | 'completed'
  runId?: string
  launching?: boolean
}

export interface DocumentPipelineWait {
  state?: DocumentPipelineState
  onState?: (state: DocumentPipelineState) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function parseDocumentPipelineState(value: string | null): DocumentPipelineState | undefined {
  if (value === null) return undefined
  const state = JSON.parse(value) as DocumentPipelineState
  if (!state || !UUID.test(state.datasetId) || !Array.isArray(state.dataIds) || !state.dataIds.length || !state.dataIds.every(id => typeof id === 'string' && UUID.test(id))
    || (state.runId !== undefined && !UUID.test(state.runId))
    || (state.launching !== undefined && typeof state.launching !== 'boolean')
    || (state.terminal !== undefined && (!['failed', 'completed'].includes(state.terminal) || !state.runId))
    || (state.launching === true && !!state.runId)) {
    throw new Error('Invalid saved document pipeline state')
  }
  return state
}

/** Store once, persist each phase, and await only the accepted graph run. */
export async function processDocumentPipeline(
  opts: CogneeHttpOptions,
  args: { texts: string[]; datasetName: string; nodeSet?: string[]; wait: DocumentPipelineWait },
): Promise<CogneeRememberResult> {
  const timeoutMs = args.wait.timeoutMs ?? 30 * 60 * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid document pipeline deadline')
  const interval = args.wait.pollIntervalMs ?? 5_000
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('Invalid document pipeline poll interval')
  const deadline = performance.now() + timeoutMs
  const url = (path: string) => `${opts.baseUrl.replace(/\/+$/, '')}/api/v1${path}`
  const authorization: Record<string, string> = opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}
  async function request(path: string, init: RequestInit): Promise<unknown | null> {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return null
    try {
      const response = await fetch(url(path), {
        ...init,
        headers: { ...authorization, ...init.headers },
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(opts.timeoutMs ?? 30_000, 30_000, remaining)))),
      })
      return response.ok ? await response.json() : null
    } catch { return null }
  }
  async function save(state: DocumentPipelineState): Promise<void> {
    await args.wait.onState?.({ ...state })
  }
  let state = args.wait.state ? { ...args.wait.state } : undefined
  if (state) parseDocumentPipelineState(JSON.stringify(state))
  if (!state) {
    const form = new FormData()
    args.texts.forEach((text, index) => form.append('data', new File([text], `document-${index}.txt`, { type: 'text/plain' })))
    form.append('datasetName', args.datasetName)
    args.nodeSet?.forEach(tag => form.append('node_set', tag))
    const added = await request('/add', { method: 'POST', body: form }) as {
      status?: string; dataset_id?: string; dataset_name?: string; data_ingestion_info?: Array<{ data_id?: string }>
    } | null
    if (!added || added.status !== 'PipelineRunCompleted' || added.dataset_name !== args.datasetName
      || !UUID.test(added.dataset_id ?? '') || !Array.isArray(added.data_ingestion_info) || !added.data_ingestion_info.length
      || !added.data_ingestion_info.every(entry => UUID.test(entry?.data_id ?? ''))) {
      return { error: 'cognee did not confirm document storage' }
    }
    state = { datasetId: added.dataset_id!, dataIds: [...new Set(added.data_ingestion_info.map(entry => entry.data_id!))] }
    await save(state)
  }
  if (!state.runId) {
    // A lost launch response is ambiguous. Never launch another graph run on retry.
    if (state.launching) return { error: 'cognee graph launch outcome is unknown; inspect sidecar activity before retrying' }
    state.launching = true
    await save(state)
    const response = await request('/cognify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ datasetIds: [state.datasetId], runInBackground: true }),
    }) as Record<string, { status?: string; dataset_id?: string; dataset_name?: string; pipeline_run_id?: string }> | null
    const run = response?.[state.datasetId]
    if (!run || run.dataset_id !== state.datasetId || run.dataset_name !== args.datasetName || !UUID.test(run.pipeline_run_id ?? '')
      || !['PipelineRunStarted', 'PipelineRunCompleted', 'PipelineRunErrored'].includes(run.status ?? '')) {
      return { error: 'cognee did not confirm the graph pipeline identity' }
    }
    state.runId = run.pipeline_run_id!
    state.launching = false
    if (run.status === 'PipelineRunErrored') state.terminal = 'failed'
    await save(state)
  }
  while (performance.now() < deadline) {
    const records = await request(`/activity/pipeline-runs?dataset_id=${encodeURIComponent(state.datasetId)}&pipeline_name=cognify_pipeline&limit=500`, { method: 'GET' })
    if (Array.isArray(records)) {
      const matching = records.filter(row => row && row.pipeline_run_id === state.runId
        && row.dataset_id === state.datasetId && row.dataset_name === args.datasetName && row.pipeline_name === 'cognify_pipeline')
      if (matching.some(row => row.status === 'DATASET_PROCESSING_ERRORED')) {
        state.terminal = 'failed'
        await save(state)
        return { error: 'cognee document graph pipeline failed', pipeline_run_id: state.runId, dataset_id: state.datasetId }
      }
      if (matching.some(row => row.status === 'DATASET_PROCESSING_COMPLETED')) {
        const readiness = await request(`/datasets/${encodeURIComponent(state.datasetId)}/processing-status`, { method: 'GET' }) as { items?: Array<{ id?: string; completed?: boolean }> } | null
        if (Array.isArray(readiness?.items) && state.dataIds.every(id => readiness.items!.some(item => item.id === id && item.completed === true))) {
          state.terminal = 'completed'
          await save(state)
          return { status: 'completed', items_processed: state.dataIds.length, pipeline_run_id: state.runId, dataset_id: state.datasetId }
        }
      }
    }
    const remaining = deadline - performance.now()
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(interval, remaining)))
  }
  return { status: 'running', error: 'Timed out waiting for the document graph; retry checks the saved pipeline without uploading again', pipeline_run_id: state.runId, dataset_id: state.datasetId }
}
