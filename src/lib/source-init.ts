/**
 * Source initialization — LLM "first scan" of every newly connected source.
 * ----------------------------------------------------------------------------
 * When a source is added (document uploaded, REST endpoint whitelisted,
 * database connected), an LLM reads a bounded sample and writes a short
 * business-context description. These descriptions flow into:
 *
 *   - the intent analyzer + smart router (which source fits which question)
 *   - the Text-to-SQL prompt (table descriptions via schema-enrichment)
 *   - generateRestCall's endpoint list (endpoint descriptions)
 *
 * Why this matters: file names ("scan_001.pdf") and bare column lists carry
 * almost no signal. One sentence of what a source is ABOUT is the cheapest
 * quality multiplier in the retrieval stack.
 *
 * Everything here is best-effort and bounded:
 *   - no LLM configured → no-op (manual descriptions still work)
 *   - LLM failure → no-op (never blocks ingestion)
 *   - input truncated to a few KB (enough for a summary, capped cost)
 */
import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('source-init')

const MAX_DOC_CHARS = 6000
const MAX_SAMPLE_ROWS = 3
const MAX_SAMPLE_CHARS = 1500

async function llmSummarize(system: string, user: string): Promise<string | null> {
  try {
    const { getRoleLlmConfig } = await import('@/lib/llm-config')
    const { chatOnce } = await import('@/lib/llm-client')
    const cfg = await getRoleLlmConfig('query')
    if (!cfg) return null
    const raw = await chatOnce(
      cfg,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      0,
      'source-init',
    )
    const text = raw.replace(/^["']|["']$/g, '').trim()
    return text.length > 0 ? text.slice(0, 400) : null
  } catch (e) {
    log.warn('source-init summarization failed', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Generate (or regenerate) the LLM description for a document and persist it
 * to Document.description. Called fire-and-forget after upload when no manual
 * description was provided.
 */
export async function initDocumentContext(documentId: string): Promise<void> {
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, name: true, category: true, description: true, contentText: true },
  })
  if (!doc) return

  const description = await llmSummarize(
    'You describe documents for an enterprise retrieval system. In 1-2 sentences, state what this document is about: its topic, scope, and what questions it can answer. Be concrete (mention entities, processes, or document type). Plain text only, no quotes, no preamble.',
    `File name: ${doc.name}\nCategory: ${doc.category ?? '-'}\n\nContent sample:\n${doc.contentText.slice(0, MAX_DOC_CHARS)}`,
  )
  if (!description) return

  await db.document.update({
    where: { id: documentId },
    data: { description },
  }).catch(() => {})
  log.info('document context initialized', { documentId, chars: description.length })
}

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------

/**
 * Generate the description for a whitelisted REST endpoint from its method,
 * path, parameter schema and a sample response. Persisted to
 * RestApiEndpoint.description — which generateRestCall renders into its
 * endpoint-selection prompt (empty descriptions there degrade routing badly).
 */
export async function initRestEndpointContext(endpointId: string): Promise<void> {
  const endpoint = await db.restApiEndpoint.findUnique({
    where: { id: endpointId },
    select: {
      id: true,
      method: true,
      path: true,
      parameterSchema: true,
      sampleResponse: true,
      description: true,
      connector: { select: { name: true, baseUrl: true } },
    },
  })
  if (!endpoint) return

  const description = await llmSummarize(
    'You describe REST API endpoints for an enterprise assistant that picks the right endpoint for a user question. In 1-2 sentences, state what data this endpoint returns and what questions it can answer. Mention key entities and filters. Plain text only.',
    `Connector: ${endpoint.connector.name} (${endpoint.connector.baseUrl})\n` +
      `Endpoint: ${endpoint.method} ${endpoint.path}\n` +
      `Parameters: ${endpoint.parameterSchema ?? '-'}\n` +
      `Sample response: ${(endpoint.sampleResponse ?? '-').slice(0, MAX_SAMPLE_CHARS)}`,
  )
  if (!description) return

  await db.restApiEndpoint.update({
    where: { id: endpointId },
    data: { description },
  }).catch(() => {})
  log.info('REST endpoint context initialized', { endpointId })
}

// ---------------------------------------------------------------------------
// Database integration (wrapper over schema-enrichment with a status summary)
// ---------------------------------------------------------------------------

/**
 * Re-run the table-description pass and refresh the integration-level
 * context blurb. Wraps the existing enrichSchemaDescriptions so callers have
 * one "init this source" entry point.
 */
export async function initIntegrationContext(integrationId: string): Promise<void> {
  const { enrichSchemaDescriptions } = await import('@/lib/schema-enrichment')
  await enrichSchemaDescriptions(integrationId, '').catch(() => {})
}

/** Exposed for tests. */
export const SOURCE_INIT_LIMITS = {
  MAX_DOC_CHARS,
  MAX_SAMPLE_ROWS,
  MAX_SAMPLE_CHARS,
} as const
