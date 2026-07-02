-- Vector DB config + Smart Mapping AI.
-- SQLite-safe additive migration.

CREATE TABLE IF NOT EXISTS VectorStoreConfig (
  id TEXT PRIMARY KEY NOT NULL,
  companyId TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'INTERNAL',
  baseUrl TEXT,
  encryptedApiKey TEXT,
  collectionName TEXT NOT NULL DEFAULT 'ryasai_chunks',
  vectorSize INTEGER NOT NULL DEFAULT 1536,
  distance TEXT NOT NULL DEFAULT 'Cosine',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL,
  CONSTRAINT VectorStoreConfig_companyId_fkey
    FOREIGN KEY (companyId) REFERENCES Company(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS VectorStoreConfig_companyId_idx
  ON VectorStoreConfig(companyId);
CREATE INDEX IF NOT EXISTS VectorStoreConfig_provider_idx
  ON VectorStoreConfig(provider);

CREATE TABLE IF NOT EXISTS SmartMapping (
  id TEXT PRIMARY KEY NOT NULL,
  companyId TEXT NOT NULL,
  sourceType TEXT NOT NULL,
  sourceId TEXT,
  sourceName TEXT NOT NULL,
  entityType TEXT NOT NULL,
  routingHint TEXT NOT NULL,
  fieldsJson TEXT NOT NULL,
  synonymsJson TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL,
  CONSTRAINT SmartMapping_companyId_fkey
    FOREIGN KEY (companyId) REFERENCES Company(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS SmartMapping_companyId_idx
  ON SmartMapping(companyId);
CREATE INDEX IF NOT EXISTS SmartMapping_sourceType_idx
  ON SmartMapping(sourceType);
CREATE INDEX IF NOT EXISTS SmartMapping_sourceId_idx
  ON SmartMapping(sourceId);
CREATE INDEX IF NOT EXISTS SmartMapping_routingHint_idx
  ON SmartMapping(routingHint);
CREATE INDEX IF NOT EXISTS SmartMapping_status_idx
  ON SmartMapping(status);
