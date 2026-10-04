/**
 * The RAG evidence pipeline, written ONCE for both transports.
 *
 * `runRagBranch` (non-streaming) and `prepareRagStream` (streaming) carried the same ~100 lines — retrieval with
 * reflection, the untrusted context wrapping, the reflection note, per-document source guidance, citations and the
 * RAG_SEARCH audit — and every parity fix on this path had to be made twice (the source-guidance and ownContent fixes
 * were each found missing from one copy). Like `sql-pipeline.ts`, this module decides WHAT the answer is built from
 * and what is recorded; the adapters only choose a whole answer or a token stream.
 */
import { db } from '@/lib/db'
import { requireOrgContext } from '@/lib/prisma-tenant'
import { getPromptSettings } from '@/lib/prompt-settings'
import { retrieveWithReflection } from '@/lib/intent-pipeline'
import { RAG_ANSWER_TOP_K, settleRetrieval, type SpeculativeRetrieval } from '@/lib/speculative-retrieval'
import { buildSourceGuidance } from '@/lib/source-guidance'
import { wrapUntrusted } from '@/lib/evidence-boundary'
import { buildDocumentCitation } from '@/lib/tool-utils'
import type { Citation } from '@/lib/types'

type Retrieval = Awaited<ReturnType<typeof retrieveWithReflection>>

export interface RagEvidenceArgs {
  question: string
  documentIds?: string[] | null
  speculativeRetrieval?: SpeculativeRetrieval | null
}

export type RagEvidence =
  /** Retrieval threw: the caller answers from chat and records the degradation. */
  | { kind: 'degraded'; reason: string }
  /** Retrieval found nothing (no chunks, no graph context): the caller answers from chat. */
  | { kind: 'empty' }
  | {
      kind: 'ready'
      /** Wrapped evidence — what the answer's tool-run summary describes. */
      context: string
      /** Source guidance + evidence + reflection note — what the answer model receives. */
      answerContext: string
      citations: Citation[]
      citationTrail: Retrieval['citationTrail']
    }

/**
 * The note added when reflection judged the evidence insufficient after a second pass. It tells the model to say its
 * SEARCH did not find the answer rather than claim the document or policy does not exist — the search can miss.
 */
export const INSUFFICIENT_EVIDENCE_NOTE =
  `\n\n[Note: The retrieved evidence may not fully address the question. Answer based only on the evidence above.` +
  ` If the answer is not in the evidence, say that YOUR SEARCH did not find it — phrase it as "saya tidak` +
  ` menemukan ini dalam dokumen yang terambil" — and do NOT claim the document or policy does not exist,` +
  ` because the search may simply have missed it. Never state that a procedure or figure is absent from the` +
  ` documents; state only what you did not find.]`

export async function gatherRagEvidence(args: RagEvidenceArgs): Promise<RagEvidence> {
  let retrieval: Retrieval
  try {
    const request = { query: args.question, documentIds: args.documentIds, topK: RAG_ANSWER_TOP_K }
    retrieval = await settleRetrieval(args.speculativeRetrieval, request, () => retrieveWithReflection(request))
  } catch (e) {
    return { kind: 'degraded', reason: e instanceof Error ? e.message : String(e) }
  }
  const topChunks = retrieval.chunks
  if (topChunks.length === 0 && !retrieval.graphContext) return { kind: 'empty' }

  const chunkContext = topChunks
    .map((item) => `[Source: ${item.documentName}, chunk #${item.chunkIndex}, score ${item.score}]\n${item.content}`)
    .join('\n\n---\n\n')
  // Retrieved text is DATA: wrapped so instructions inside a document never acquire system authority.
  const context = retrieval.graphContext
    ? `${wrapUntrusted('CONTEXT (DOCUMENTS):', chunkContext)}\n\n${wrapUntrusted('CONTEXT (KNOWLEDGE GRAPH):', retrieval.graphContext)}`
    : wrapUntrusted('CONTEXT (DOCUMENTS):', chunkContext)

  const reflectionNote = !retrieval.reflection.sufficient && retrieval.retrievalPasses >= 2 ? INSUFFICIENT_EVIDENCE_NOTE : ''

  // Admin-authored guidance of the documents that actually contributed evidence, plus the org-level RAG prompt.
  const distinctDocIds: string[] = []
  for (const c of topChunks) {
    if (c.documentId && !distinctDocIds.includes(c.documentId)) distinctDocIds.push(c.documentId)
  }
  let sourceGuidance = ''
  if (distinctDocIds.length > 0) {
    const docs = await db.document.findMany({
      where: { id: { in: distinctDocIds } },
      select: { id: true, name: true, contextPrompt: true },
    })
    const byId = new Map(docs.map((d) => [d.id, d]))
    const docPrompts = distinctDocIds
      .map((id) => byId.get(id))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .filter((d) => d.contextPrompt && d.contextPrompt.trim())
      .map((d) => ({ name: d.name, content: d.contextPrompt! }))
    const orgPrompt = (await getPromptSettings(db)).ragContextPrompt
    sourceGuidance = buildSourceGuidance(docPrompts, { budget: 2000, orgPrompt })
  }
  const answerContext = (sourceGuidance ? `${sourceGuidance}\n\n${context}` : context) + reflectionNote

  // The snippet is the chunk's OWN text: the contextual prefix is the same for every chunk of a document, so showing
  // it made three sources of one document display identical snippets.
  const citations = topChunks.map((item) =>
    buildDocumentCitation({
      documentName: item.documentName,
      chunkIndex: item.chunkIndex,
      content: item.ownContent ?? item.content,
      score: item.score,
      rank: item.rank,
    }),
  )

  await db.auditLog.create({
    data: {
      organizationId: requireOrgContext(),
      userId: null,
      action: 'RAG_SEARCH',
      severity: 'info',
      detail: JSON.stringify({
        query: args.question,
        returned: topChunks.length,
        candidatesScanned: retrieval.candidatesScanned,
        queryTokens: retrieval.queryTokens,
        topScore: topChunks[0]?.score ?? 0,
      }),
    },
  })

  return { kind: 'ready', context, answerContext, citations, citationTrail: retrieval.citationTrail }
}
