-- RAG lexical candidate index.
-- Uses SQLite FTS5 for BM25 candidate retrieval before detailed scoring.

CREATE VIRTUAL TABLE IF NOT EXISTS DocumentChunkFts
USING fts5(chunkId UNINDEXED, companyId UNINDEXED, content, keywords);
