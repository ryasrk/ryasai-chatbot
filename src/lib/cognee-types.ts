/**
 * Cognee — shared types and pure dataset helpers.
 * Leaf module: no deps on other cognee split files.
 */
export interface ChatTurnMemory {
  sessionId?: string
  userId?: string
  userMessage: string
  aiMessage: string
  toolRuns: Array<{ type: string; status: string; latencyMs: number }>
}

export interface GraphSearchResult {
  text: string
  source: 'summary' | 'chunk' | 'entity' | 'relationship'
  score?: number
}

/**
 * ponytail: every searchType string we may send to cognee must be one of the
 * 15 names the SDK serializes (SearchTypeString in @cognee/cognee-ts types).
 * Anything else fails remotely with "unknown SearchType '<X>'" and the whole
 * strategy is wasted. This set is the single source of truth for validation;
 * keep it in sync with node_modules/@cognee/cognee-ts/lib/types.d.ts.
 */
/**
 * How the memory card describes the backend.
 *
 * `local`/`postgres` described the STORAGE the in-process SDK was told to use
 * (kuzu+lancedb vs pgvector). The app no longer chooses storage — the cognee v1.6.0
 * server is configured by docker-compose.yml — so those two values are legacy and no
 * longer produced. `server` is what a reachable sidecar reports; `disabled` means
 * either the org toggled memory off or no COGNEE_SERVER_URL is configured.
 *
 * Kept as a union rather than replaced by a boolean because the card renders the
 * value, and "server" tells an operator more than "true" does.
 */
export type CogneeMode = 'local' | 'postgres' | 'server' | 'disabled'

export const COGNEE_SEARCH_TYPES: ReadonlySet<string> = new Set([
  'SUMMARIES', 'CHUNKS', 'RAG_COMPLETION', 'HYBRID_COMPLETION',
  'TRIPLET_COMPLETION', 'GRAPH_COMPLETION', 'GRAPH_COMPLETION_DECOMPOSITION', 'GRAPH_SUMMARY_COMPLETION',
  'CYPHER', 'NATURAL_LANGUAGE', 'GRAPH_COMPLETION_COT', 'GRAPH_COMPLETION_CONTEXT_EXTENSION',
  'FEELING_LUCKY', 'TEMPORAL', 'CODING_RULES', 'CHUNKS_LEXICAL',
  'AGENTIC_COMPLETION', 'CODE', 'GRAPH_REPORT', 'SKILLS',
])
export function isValidSearchType(t: string): boolean {
  return COGNEE_SEARCH_TYPES.has(t)
}

/**
 * Dataset names are org-scoped. In `postgres` mode several orgs can point at the
 * same cognee database, so the per-org client and per-org store directory aren't
 * enough on their own — the dataset name is the isolation boundary inside a
 * shared DB. Falls back to a dead name with no org context so a caller that
 * forgot enterWithOrg reads and writes nothing instead of the shared 'default'.
 */
import { getOrgContext } from '@/lib/prisma-tenant'

function orgKey(): string {
  return getOrgContext() ?? 'no-org'
}

export function datasetFor(): string {
  return `org:${orgKey()}`
}

export function kbDatasetFor(): string {
  return `org:${orgKey()}:kb`
}

/**
 * Did the sidecar actually STORE this write? HTTP 200 is not evidence that it did.
 *
 * MEASURED on the production sidecar: a write arriving while a dataset's cognify pipeline is busy is
 * REFUSED with a perfectly successful-looking response —
 *
 *     {"status":"running","items_processed":0,"pipeline_run_id":null}
 *
 * No error, no non-2xx. A real write holds the pipeline for 45-148s, so under any concurrent load this
 * is the COMMON answer, not an edge case (measured: four simultaneous chats produced eight refusals and
 * only two turns reached memory).
 *
 * ONE definition, imported by every write path. It was inline in the chat-memory write and in the queue
 * worker while `cognifyDocument`/`cognifyBatch` checked only `!res && !res.error` — so document cognify
 * was reporting `completed` (and `processed: 1`) for writes the sidecar had refused, which is the same
 * false success this predicate exists to remove. A second copy is how the two drifted apart once
 * already; `res.items_processed` is undefined on a response that omits the field, so an older/other
 * shape is NOT treated as refused.
 */
export function writeNotStored(res: {
  status?: string
  items_processed?: number
  /**
   * Declared even though the decision ignores it, so the PRODUCTION payload can be passed verbatim.
   *
   * `tsc` caught this the moment a test used the measured shape
   * (`{ status: 'running', items_processed: 0, pipeline_run_id: null }`): the old type rejected the exact
   * body the sidecar sends, which would force every caller holding that object to narrow it first —
   * inviting a copied literal to be tested instead of the response that actually arrived.
   */
  pipeline_run_id?: string | null
} | null): boolean {
  if (!res) return true
  return res.status === 'running' || res.items_processed === 0
}

/**
 * Bound what one chat turn contributes to cognee's write path, and MARK the truncation.
 *
 * LIVES HERE because BOTH write paths need it and they had ALREADY diverged: the inline fallback called
 * this, while `performMemoryWrite` (the queue worker) did a bare `.slice(0, MEMORY_WRITE_MAX_CHARS)`.
 * MEASURED on the queue path: a turn twice the limit arrived clipped to exactly the limit with NO
 * marker — while `cognee-memory.ts`'s comment directly above the queue call asserted "both paths still
 * build the same payload, because both call `capWritePayload` and the same JSON shape".
 *
 * The marker is the point, not the clip: this text is read back verbatim into future prompts, so a reader
 * — human or model — must be able to tell a clipped turn from a conversation that ended there. A silent
 * clip reads as "the user said no more". Takes `maxChars` as an argument rather than importing
 * MEMORY_WRITE_MAX_CHARS, so this stays a leaf module with no dependency on `constants`.
 */
export function capWritePayload(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[memory truncated for extraction]`
}
