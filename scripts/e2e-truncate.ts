/**
 * E2E truncate — empties every org-scoped table between runs.
 * `prisma db push` only guarantees the SCHEMA; when the schema is unchanged
 * it leaves previous runs' rows alive, which made the setup-wizard spec skip
 * signup (hasAdmin=true → Sign In) on every run after the first.
 */
import { PrismaClient } from '@prisma/client'

const TABLES = [
  'AuditLog', 'ChatMessage', 'ChatSession', 'AgentRun', 'ToolRun',
  'DocumentChunk', 'KgRelation', 'DocumentVersion', 'Document',
  'IntegrationSchema', 'QueryHistory', 'Integration',
  'LlmUsageLog', 'LlmConfig', 'VectorStoreConfig',
  'RestApiRequestLog', 'RestApiEndpoint', 'RestApiConnector',
  'ApiRequestLog', 'ApiKey', 'Plugin', 'McpServer',
  'ScheduledRunLog', 'ScheduledRun', 'NotificationConfig',
  'Invitation', 'SavedPrompt', 'User', 'Organization', 'AppConfig',
]

const db = new PrismaClient()
const list = TABLES.map((t) => `"${t}"`).join(', ')
await db.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`)
await db.$disconnect()
console.log(`[e2e-truncate] emptied ${TABLES.length} tables`)
