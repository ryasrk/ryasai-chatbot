export type DbProtocolFamily = 'POSTGRESQL' | 'MYSQL' | 'MSSQL' | 'CLICKHOUSE'

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
  { id: 'POSTGRESQL', label: 'PostgreSQL', family: 'POSTGRESQL', defaultPort: 5432, hint: 'Open-source relational database', connectionFormat: 'host:port/db' },
  { id: 'MYSQL', label: 'MySQL / MariaDB', family: 'MYSQL', defaultPort: 3306, hint: 'Popular relational database', connectionFormat: 'host:port/db' },
  { id: 'MSSQL', label: 'Microsoft SQL Server', family: 'MSSQL', defaultPort: 1433, hint: 'Microsoft enterprise database', connectionFormat: 'host:port/db' },
  { id: 'SUPABASE', label: 'Supabase (PostgreSQL)', family: 'POSTGRESQL', defaultPort: 5432, hint: 'Managed PostgreSQL with connection pooling', connectionFormat: 'host:port/db', sslByDefault: true },
  { id: 'NEON', label: 'Neon (PostgreSQL)', family: 'POSTGRESQL', defaultPort: 5432, hint: 'Serverless PostgreSQL with branching', connectionFormat: 'host:port/db', sslByDefault: true },
  { id: 'PLANETSCALE', label: 'PlanetScale (MySQL)', family: 'MYSQL', defaultPort: 3306, hint: 'Serverless MySQL platform', connectionFormat: 'host:port/db', sslByDefault: true },
  { id: 'TIDB', label: 'TiDB (MySQL-compatible)', family: 'MYSQL', defaultPort: 4000, hint: 'Distributed SQL, MySQL-compatible', connectionFormat: 'host:port/db', sslByDefault: true },
  { id: 'COCKROACHDB', label: 'CockroachDB (PostgreSQL)', family: 'POSTGRESQL', defaultPort: 26257, hint: 'Distributed SQL, PostgreSQL-compatible', connectionFormat: 'host:port/db', sslByDefault: true },
  { id: 'CLICKHOUSE', label: 'ClickHouse', family: 'CLICKHOUSE', defaultPort: 8123, hint: 'Columnar OLAP database', connectionFormat: 'host:port/db' },
]

export function getDbProviderPreset(id: string): DbProviderPreset | undefined {
  return DB_PROVIDER_PRESETS.find(p => p.id === id)
}

export function getDbProtocolFamily(providerId: string): DbProtocolFamily {
  const preset = getDbProviderPreset(providerId)
  if (preset) return preset.family
  if (providerId === 'POSTGRESQL' || providerId === 'MYSQL' || providerId === 'MSSQL') return providerId as DbProtocolFamily
  return 'POSTGRESQL'
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
