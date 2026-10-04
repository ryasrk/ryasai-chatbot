import { afterAll, beforeEach, expect, test } from 'bun:test'
import { processDocumentPipeline, parseDocumentPipelineState, type DocumentPipelineState } from './cognee-document-pipeline'

const datasetId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const dataId = '33333333-3333-4333-8333-333333333333'
const datasetName = 'org:fixture:kb'
const opts = { baseUrl: 'http://cognee.invalid', apiKey: 'fixture-key' }
const stored = { status: 'PipelineRunCompleted', dataset_id: datasetId, dataset_name: datasetName, data_ingestion_info: [{ data_id: dataId }] }
const launched = { [datasetId]: { status: 'PipelineRunStarted', dataset_id: datasetId, dataset_name: datasetName, pipeline_run_id: runId } }
const event = (status: string, overrides = {}) => ({ pipeline_run_id: runId, dataset_id: datasetId, dataset_name: datasetName, pipeline_name: 'cognify_pipeline', status, ...overrides })
const ready = { items: [{ id: dataId, completed: true }] }
const existing: DocumentPipelineState = { datasetId, runId, dataIds: [dataId] }
const originalFetch = globalThis.fetch
let responses: Array<unknown | Response> = []
let calls: Array<{ url: string; init: RequestInit }> = []
let saved: DocumentPipelineState[] = []

beforeEach(() => {
  responses = []
  calls = []
  saved = []
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    const response = responses.shift() ?? []
    return response instanceof Response ? response : Response.json(response)
  }) as typeof fetch
})
afterAll(() => { globalThis.fetch = originalFetch })
const execute = (state?: DocumentPipelineState, timeoutMs = 100) => processDocumentPipeline(opts, {
  texts: ['complete document text'], datasetName, nodeSet: ['doc-1'],
  wait: { state, timeoutMs, pollIntervalMs: 1, onState: async value => { saved.push(value) } },
})

test('storage, launch and completion remain distinct; the exact stored file must be ready', async () => {
  responses = [stored, launched, [event('DATASET_PROCESSING_STARTED')], [event('DATASET_PROCESSING_COMPLETED')], { items: [{ id: dataId, completed: false }] }, [event('DATASET_PROCESSING_COMPLETED')], ready]
  const result = await execute()
  expect(result.status).toBe('completed')
  expect(result.items_processed).toBe(1)
  expect(result.pipeline_run_id).toBe(runId)
  expect(saved.map(state => [!!state.runId, !!state.launching, state.terminal])).toEqual([
    [false, false, undefined], [false, true, undefined], [true, false, undefined], [true, false, 'completed'],
  ])
  expect(calls.map(call => call.init.method)).toEqual(['POST', 'POST', 'GET', 'GET', 'GET', 'GET', 'GET'])
  const form = calls[0].init.body as FormData
  expect(await (form.get('data') as File).text()).toBe('complete document text')
  expect(form.getAll('node_set')).toEqual(['doc-1'])
  expect(JSON.parse(String(calls[1].init.body))).toEqual({ datasetIds: [datasetId], runInBackground: true })
})

test('resuming a known run never uploads or launches another pipeline', async () => {
  responses = [[event('DATASET_PROCESSING_COMPLETED')], ready]
  expect((await execute(existing)).status).toBe('completed')
  expect(calls.every(call => call.init.method === 'GET')).toBe(true)
})

test('an unrelated run or another dataset cannot satisfy completion', async () => {
  responses = [[event('DATASET_PROCESSING_COMPLETED', { pipeline_run_id: datasetId }), event('DATASET_PROCESSING_COMPLETED', { dataset_id: runId }), event('DATASET_PROCESSING_COMPLETED', { dataset_name: 'org:foreign:kb' })], ready]
  expect((await execute(existing, 10)).status).toBe('running')
  expect(saved.some(state => state.terminal === 'completed')).toBe(false)
})

test('another ready file cannot stand in for the uploaded file', async () => {
  responses = [[event('DATASET_PROCESSING_COMPLETED')], { items: [{ id: datasetId, completed: true }] }]
  expect((await execute(existing, 10)).status).toBe('running')
})

test('a terminal pipeline failure is recorded without claiming completion', async () => {
  responses = [[event('DATASET_PROCESSING_ERRORED')]]
  const result = await execute(existing)
  expect(result.error).toContain('pipeline failed')
  expect(result.status).not.toBe('completed')
  expect(saved[0].terminal).toBe('failed')
})

test('outages preserve the accepted run and expire without a new upload', async () => {
  responses = [new Response('provider echoed secret', { status: 503 })]
  const result = await execute(existing, 10)
  expect(result.status).toBe('running')
  expect(result.error).toContain('retry checks the saved pipeline')
  expect(JSON.stringify(result)).not.toContain('secret')
  expect(calls.every(call => call.init.method === 'GET')).toBe(true)
})

test('an ambiguous launch is not repeated after a lost response', async () => {
  const result = await execute({ datasetId, dataIds: [dataId], launching: true })
  expect(result.error).toContain('launch outcome is unknown')
  expect(calls).toHaveLength(0)
})

test('a stored phase resumes at graph launch without adding data again', async () => {
  responses = [launched, [event('DATASET_PROCESSING_COMPLETED')], ready]
  expect((await execute({ datasetId, dataIds: [dataId] })).status).toBe('completed')
  expect(calls[0].url).toEndWith('/cognify')
  expect(calls.some(call => call.url.endsWith('/add'))).toBe(false)
})

test('unconfirmed or foreign storage never launches graph processing', async () => {
  for (const body of [{ ...stored, status: 'PipelineRunStarted' }, { ...stored, dataset_name: 'org:foreign:kb' }, { ...stored, data_ingestion_info: [] }]) {
    responses = [body]
    const previous = calls.length
    expect((await execute()).error).toContain('document storage')
    expect(calls.length - previous).toBe(1)
  }
})

test('a failed state write aborts the phase before launching anything', async () => {
  responses = [stored, launched, [event('DATASET_PROCESSING_COMPLETED')], ready]
  await expect(processDocumentPipeline(opts, { texts: ['text'], datasetName, wait: { onState: async () => { throw new Error('state write failed') } } })).rejects.toThrow('state write failed')
  expect(calls).toHaveLength(1)
})

test('invalid persisted metadata fails closed before a request', async () => {
  expect(parseDocumentPipelineState(null)).toBeUndefined()
  expect(parseDocumentPipelineState(JSON.stringify(existing))).toEqual(existing)
  for (const value of ['garbage', 'null', '{}', JSON.stringify({ ...existing, dataIds: [] }), JSON.stringify({ ...existing, runId: 'foreign/endpoint' })]) {
    expect(() => parseDocumentPipelineState(value)).toThrow()
  }
  await expect(execute({ ...existing, datasetId: 'invalid' })).rejects.toThrow('Invalid saved')
  expect(calls).toHaveLength(0)
})
