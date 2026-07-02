-- Hybrid RAG API embeddings columns.
-- Safe for SQLite: nullable columns, no data rewrite required.

ALTER TABLE DocumentChunk ADD COLUMN embeddingJson TEXT;
ALTER TABLE DocumentChunk ADD COLUMN embeddingProvider TEXT;
ALTER TABLE DocumentChunk ADD COLUMN embeddingModel TEXT;
ALTER TABLE DocumentChunk ADD COLUMN embeddedAt DATETIME;

ALTER TABLE LlmConfig ADD COLUMN embeddingProvider TEXT;
ALTER TABLE LlmConfig ADD COLUMN embeddingBaseUrl TEXT;
ALTER TABLE LlmConfig ADD COLUMN encryptedEmbeddingApiKey TEXT;
ALTER TABLE LlmConfig ADD COLUMN embeddingModel TEXT;
ALTER TABLE LlmConfig ADD COLUMN embeddingAvailableModels TEXT;
ALTER TABLE LlmConfig ADD COLUMN lastEmbeddingModelSyncAt DATETIME;

CREATE INDEX IF NOT EXISTS DocumentChunk_embeddingModel_idx
  ON DocumentChunk(embeddingModel);
