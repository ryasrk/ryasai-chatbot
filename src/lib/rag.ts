/**
 * Public surface of the retrieval layer. A barrel only: tokens and scoring live in `rag-scoring.ts`, chunking in
 * `rag-chunking.ts`, retrieval in `rag-retrieval.ts`. Modules INSIDE that layer import the leaf they need, never this
 * file — this file imports `rag-retrieval`, so a member importing it back is an import cycle.
 */
export * from './rag-scoring'
export { chunkText, detectDocType, extractFileText } from './rag-chunking'
export { retrieveRelevantChunks, invalidateRagCache, getRagCacheStats, rerankMergedChunks, ragRerankEnabled } from './rag-retrieval'
