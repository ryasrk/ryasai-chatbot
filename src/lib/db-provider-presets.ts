export type DbProtocolFamily = 'POSTGRESQL' | 'MYSQL' | 'MSSQL' | 'MONGODB' | 'CLICKHOUSE' | 'SNOWFLAKE' | 'ORACLE' | 'SQLITE_DEMO'

export interface DbProviderPreset {
  id: string
  label: string
  family: DbProtocolFamily
  defaultPort: number
  hint: string
  connectionFormat: string
  sslByDefault?: boolean
  needsConnectionString?: boolean
}

export const DB_PROVIDER_PRESETS: DbProviderPreset[] = [
  { id: 'SQLITE_DEMO', label: 'SQLite Demo (Internal)', family: 'SQLITE_DEMO', defaultPort: 0, hint: 'Sample dataset ERP untuk testing', connectionFormat: 'internal' },
  { id: 'POSTGRESQL', label: 'PostgreSQL', family: 'POSTGRESQL', defaultPort: 5432, hint: 'Database relasional open-source', connectionFormat: 'host:port/db' },
  { id: 'MYSQL', label: 'MySQL / MariaDB', family: 'MYSQL', defaultPort: 3306, hint: 'Database relasional populer', connectionFormat: 'host:port/db' },
  { id: 'MSSQL', label: 'Microsoft SQL Server', family: 'MSSQL', defaultPort: 1433, hint: 'Database enterprise Microsoft', connectionFormat: 'host:port/db' },
  { id: 'SUPABASE', label: 'Supabase (PostgreSQL)', family: 'POSTGRESQL', defaultPort: 5432, hint: 'PostgreSQL managed dengan connection pooling', connectionFormat: 'host:port/db', sslByDefault: true },
  { id: 'NEON', label: 'Neon (PostgreSQL)', family: 'POSTGRESQL', defaultPort: 5432, hint: 'Serverless PostgreSQL dengan branching', connectionFormat: 'host:port/db', sslByDefault: true },
  { id: 'PLANETSCALE', label: 'PlanetScale (MySQL)', family: 'MYSQL', defaultPort: 3306, hint: 'Serverless MySQL platform', connectionFormat: 'host:port/db', sslByDefault: true },
  { id: 'TIDB', label: 'TiDB (MySQL-compatible)', family: 'MYSQL', defaultPort: 4000, hint: 'Distributed SQL, MySQL-compatible', connectionFormat: 'host:port/db', sslByDefault: true },
  { id: 'COCKROACHDB', label: 'CockroachDB (PostgreSQL)', family: 'POSTGRESQL', defaultPort: 26257, hint: 'Distributed SQL, PostgreSQL-compatible', connectionFormat: 'host:port/db', sslByDefault: true },
  { id: 'MONGODB', label: 'MongoDB', family: 'MONGODB', defaultPort: 27017, hint: 'Document database NoSQL', connectionFormat: 'connection_string', needsConnectionString: true },
  { id: 'ORACLE', label: 'Oracle Database', family: 'ORACLE', defaultPort: 1521, hint: 'Database enterprise Oracle', connectionFormat: 'host:port/service' },
  { id: 'SNOWFLAKE', label: 'Snowflake', family: 'SNOWFLAKE', defaultPort: 443, hint: 'Cloud data warehouse', connectionFormat: 'account/database', sslByDefault: true, needsConnectionString: true },
  { id: 'CLICKHOUSE', label: 'ClickHouse', family: 'CLICKHOUSE', defaultPort: 8123, hint: 'Columnar OLAP database', connectionFormat: 'host:port/db' },
  { id: 'DATABRICKS', label: 'Databricks', family: 'SNOWFLAKE', defaultPort: 443, hint: 'Lakehouse platform', connectionFormat: 'connection_string', sslByDefault: true, needsConnectionString: true },
]

export function getDbProviderPreset(id: string): DbProviderPreset | undefined {
  return DB_PROVIDER_PRESETS.find(p => p.id === id)
}

export function getDbProtocolFamily(providerId: string): DbProtocolFamily {
  const preset = getDbProviderPreset(providerId)
  if (preset) return preset.family
  if (providerId === 'POSTGRESQL' || providerId === 'MYSQL' || providerId === 'MSSQL') return providerId as DbProtocolFamily
  return 'SQLITE_DEMO'
}

export const VALID_DB_PROVIDER_IDS = DB_PROVIDER_PRESETS.map(p => p.id)

export interface VectorStorePreset {
  id: string
  label: string
  backend: 'INTERNAL' | 'QDRANT' | 'MILVUS'
  baseUrlPlaceholder: string
  needsApiKey: boolean
  defaultVectorSize: number
  hint?: string
}

export const VECTOR_STORE_PRESETS: VectorStorePreset[] = [
  { id: 'INTERNAL', label: 'Internal (SQLite)', backend: 'INTERNAL', baseUrlPlaceholder: '', needsApiKey: false, defaultVectorSize: 1536 },
  { id: 'QDRANT', label: 'Qdrant (Local)', backend: 'QDRANT', baseUrlPlaceholder: 'http://localhost:6333', needsApiKey: false, defaultVectorSize: 1536 },
  { id: 'QDRANT_CLOUD', label: 'Qdrant Cloud', backend: 'QDRANT', baseUrlPlaceholder: 'https://cluster-id.qdrant.tech:6333', needsApiKey: true, defaultVectorSize: 1536, hint: 'API key required for Qdrant Cloud' },
  { id: 'MILVUS', label: 'Milvus', backend: 'MILVUS', baseUrlPlaceholder: 'http://localhost:19530', needsApiKey: false, defaultVectorSize: 1536 },
]

export function getVectorStorePreset(id: string): VectorStorePreset | undefined {
  return VECTOR_STORE_PRESETS.find(p => p.id === id)
}

export function getVectorStoreBackend(providerId: string): string {
  const preset = getVectorStorePreset(providerId)
  if (preset) return preset.backend
  return providerId
}

export const VALID_VECTOR_STORE_PROVIDER_IDS = VECTOR_STORE_PRESETS.map(p => p.id)
