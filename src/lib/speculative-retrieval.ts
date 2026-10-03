/**
 * Start document retrieval NOW, alongside intent analysis and tool selection, instead of after them.
 *
 * WHY. A document question pays four LLM-bound stages in a row: [intent ∥ tool selection] (~2.3 s, already
 * overlapped by `SPECULATIVE_ROUTING`), then retrieval + rerank (~2.2 s), then the sufficiency reflection (~1.7 s),
 * then the answer's first token (~2.2 s). MEASURED on 36 document turns: median first token 8.0 s, and the middle
 * two stages — 3.9 s of it — wait for a routing verdict they do not read. `retrieveWithReflection` takes the
 * effective question and the document scope, nothing else; the routing result decides only WHETHER its output is
 * used. Started together the wait is the slower of the two, and the output is identical because the inputs are.
 *
 * THE PRICE, STATED. A turn that routes to SQL, REST, a plugin or plain chat has spent a retrieval and, usually,
 * a rerank and a reflection call it did not need — on the customer's own key. `SPECULATIVE_RETRIEVAL=false` turns it
 * off. The same trade `SPECULATIVE_ROUTING` made, one stage larger.
 *
 * WHAT KEEPS IT HONEST.
 *  - The result is only ever reused for the EXACT request it was started for (`sameRequest`). A branch that asks for
 *    a different question, `topK` or document scope gets a fresh retrieval — a speculative result for the wrong scope
 *    would be a cross-scope leak with no error, so a mismatch discards it rather than trusting the caller.
 *  - It is settled into a value, never returned as a bare promise: if routing sends the turn elsewhere nobody awaits
 *    it, and a rejected promise nobody awaits is an unhandled rejection. The error is re-thrown only by the caller
 *    that actually uses the result, where the branch's existing "degrade to chat" handling applies unchanged.
 *  - It never starts for a turn that cannot reach the documents (none exist, the RAG tool is switched off, or the user
 *    pinned a database), so those pay nothing.
 */
import { retrieveWithReflection } from '@/lib/intent-pipeline'
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('speculative-retrieval')

/**
 * The number of chunks a RAG answer is built from. One constant for the speculative start AND both answer branches,
 * so the speculation cannot be started for a `topK` the branch no longer asks for.
 */
export const RAG_ANSWER_TOP_K = 4

export type Retrieval = Awaited<ReturnType<typeof retrieveWithReflection>>

export interface RetrievalRequest {
  query: string
  topK: number
  /** `null`/absent = every document. */
  documentIds?: string[] | null
}

export interface SpeculativeRetrieval {
  request: RetrievalRequest
  settled: Promise<{ ok: true; value: Retrieval } | { ok: false; error: unknown }>
  /** Aborted by `cancelSpeculativeRetrieval`; the retrieval stops before its next model call. */
  controller: AbortController
}

/** A function, not a module constant: a constant binds once at import and a test setting the env afterwards would measure nothing. */
export function speculativeRetrievalEnabled(): boolean {
  return process.env.SPECULATIVE_RETRIEVAL !== 'false'
}

/** Order-insensitive: two requests naming the same documents in a different order are the same scope. */
function scopeKey(documentIds: string[] | null | undefined): string {
  return documentIds && documentIds.length > 0 ? [...documentIds].sort().join(',') : '*'
}

export function sameRequest(a: RetrievalRequest, b: RetrievalRequest): boolean {
  return a.query === b.query && a.topK === b.topK && scopeKey(a.documentIds) === scopeKey(b.documentIds)
}

export function startSpeculativeRetrieval(args: {
  question: string
  documentIds?: string[] | null
  /** Documents the org has. Zero means the RAG branch can never run. */
  documentCount: number
  /** The per-org RAG tool toggle. Off means `applyToolGating` downgrades a RAG verdict to chat. */
  ragToolEnabled: boolean
  /** The user pinned a database: the router is told to prefer it, and a RAG verdict is not what they asked for. */
  pinnedIntegration: boolean
}): SpeculativeRetrieval | null {
  if (!speculativeRetrievalEnabled()) return null
  if (args.documentCount <= 0 || !args.ragToolEnabled || args.pinnedIntegration) return null

  const request: RetrievalRequest = { query: args.question, topK: RAG_ANSWER_TOP_K, documentIds: args.documentIds }
  const controller = new AbortController()
  // An async IIFE, not a bare call: a SYNCHRONOUS throw (a missing export, a bad argument) must become a settled
  // `{ ok: false }` like any other failure, not escape this function and abort a turn that never needed the result.
  // The signal rides on the call only: `request` stays the pure identity `sameRequest` compares.
  const settled = (async () => retrieveWithReflection({ ...request, signal: controller.signal }))().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => {
      log.debug('speculative retrieval failed', { error: error instanceof Error ? error.message : String(error) })
      return { ok: false as const, error }
    },
  )
  return { request, settled, controller }
}

/**
 * The retrieval for `request`: the speculative one when it was started for exactly this request, otherwise `fallback`.
 * A failed speculative retrieval is re-thrown, which is what the real call would have done.
 */
export async function settleRetrieval(
  speculative: SpeculativeRetrieval | null | undefined,
  request: RetrievalRequest,
  fallback: () => Promise<Retrieval>,
): Promise<Retrieval> {
  if (!speculative || !sameRequest(speculative.request, request)) return fallback()
  // A cancelled retrieval was stopped on purpose, so its failure is NOT a retrieval failure. If a caller that uses the
  // result somehow reaches here after a cancel, run the real thing rather than re-throwing an AbortError into the
  // branch's degrade-to-chat handling, which would answer a document question without its documents.
  if (speculative.controller.signal.aborted) return fallback()
  const settled = await speculative.settled
  if (!settled.ok) throw settled.error
  return settled.value
}

/**
 * The turn will not use this retrieval (routed to SQL / REST / a plugin / chat, or ended by a clarification), so stop
 * it before its next model call. Safe to call repeatedly and with `null`. The retrieval settles as `{ ok: false }`,
 * which nobody awaits — the same non-event as any other speculative result that goes unused.
 */
export function cancelSpeculativeRetrieval(speculative: SpeculativeRetrieval | null | undefined): void {
  speculative?.controller.abort()
}
