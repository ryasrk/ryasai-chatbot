import { EMBEDDING_DIMENSIONS } from '@/lib/constants'
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

/**
 * How generated SQL must quote identifiers on this provider, stated to the model on every SQL turn.
 *
 * WHY IT EXISTS (measured on MySQL 8.4 and MariaDB 11.4): the default Text-to-SQL rules said to double-quote every
 * table and column name, which is right for PostgreSQL and wrong for MySQL, where a double-quoted word is a STRING.
 * `FROM "customers"` is a syntax error there, and worse, `WHERE "city" = 'Jakarta'` compares two strings and
 * returns 0 rows instead of 2 — a wrong answer with no error for the repair loop to catch. The rules are editable
 * per organisation, so fixing their default text cannot reach an org that already edited it; this line is sent
 * after the rules, from code, so it always does.
 */
export function identifierQuotingRule(providerId: string): string {
  switch (getDbProtocolFamily(providerId)) {
    case 'MYSQL':
      return 'Identifier quoting for this database: wrap table and column names in backticks (`orders`.`customer_id`), '
        + 'never double quotes, and put string values in single quotes. Here a double-quoted word is a STRING, so '
        + '"status" = \'paid\' compares two strings and silently matches nothing. This overrides any rule above '
        + 'that says to double-quote names.'
    case 'MSSQL':
      return 'Identifier quoting for this database: use double quotes or [brackets] for table and column names, never '
        + 'backticks; string values go in single quotes.'
    default:
      return 'Identifier quoting for this database: use double quotes for table and column names, never backticks; '
        + 'string values go in single quotes.'
  }
}

export const VALID_DB_PROVIDER_IDS = DB_PROVIDER_PRESETS.map(p => p.id)

export interface VectorStorePreset {
  id: string
  label: string
  backend: 'INTERNAL' | 'QDRANT' | 'MILVUS' | 'PINECONE' | 'CHROMA'
  baseUrlPlaceholder: string
  needsApiKey: boolean
  defaultVectorSize: number
  hint?: string
}

export const VECTOR_STORE_PRESETS: VectorStorePreset[] = [
  { id: 'INTERNAL', label: 'Internal (PostgreSQL pgvector)', backend: 'INTERNAL', baseUrlPlaceholder: '', needsApiKey: false, defaultVectorSize: EMBEDDING_DIMENSIONS },
  { id: 'QDRANT', label: 'Qdrant (Local)', backend: 'QDRANT', baseUrlPlaceholder: 'http://localhost:6333', needsApiKey: false, defaultVectorSize: EMBEDDING_DIMENSIONS },
  { id: 'QDRANT_CLOUD', label: 'Qdrant Cloud', backend: 'QDRANT', baseUrlPlaceholder: 'https://cluster-id.qdrant.tech:6333', needsApiKey: true, defaultVectorSize: EMBEDDING_DIMENSIONS, hint: 'API key required for Qdrant Cloud' },
  { id: 'MILVUS', label: 'Milvus', backend: 'MILVUS', baseUrlPlaceholder: 'http://localhost:19530', needsApiKey: false, defaultVectorSize: EMBEDDING_DIMENSIONS },
  { id: 'PINECONE', label: 'Pinecone (serverless)', backend: 'PINECONE', baseUrlPlaceholder: 'https://index-name-project.svc.region.aws.pinecone.io', needsApiKey: true, defaultVectorSize: EMBEDDING_DIMENSIONS, hint: 'Base URL is the INDEX host from the Pinecone console; create the index first (we never auto-create).' },
  { id: 'CHROMA', label: 'Chroma (self-hosted)', backend: 'CHROMA', baseUrlPlaceholder: 'http://localhost:8000', needsApiKey: false, defaultVectorSize: EMBEDDING_DIMENSIONS, hint: 'API key only needed when Chroma runs with CHROMA_SERVER_AUTHN_TOKEN' },
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
