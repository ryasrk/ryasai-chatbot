import { formatDistanceToNow } from 'date-fns'
import type { Integration } from '@/lib/types'

/* ------------------------------------------------------------------ helpers */

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return 'never'
  }
}

export const STATUS_BADGE: Record<
  Integration['status'],
  { label: string; className: string }
> = {
  active: {
    label: 'Active',
    className: 'bg-success/15 text-success border-success/20',
  },
  inactive: {
    label: 'Inactive',
    className: 'bg-muted text-muted-foreground border-border',
  },
  error: {
    label: 'Error',
    className: 'bg-destructive/15 text-destructive border-destructive/20',
  },
}

/* ------------------------------------------------------------------- types */

export interface MaskedConfig {
  host?: string
  port?: number | string
  database_name?: string
  username?: string
  password?: string
  [k: string]: unknown
}

export interface SchemaColumn {
  name: string
  type: string
  nullable?: boolean
  primaryKey?: boolean
  description?: string
}

export interface SchemaTable {
  id: string
  tableName: string
  columns: SchemaColumn[]
  rowCount: number | null
  reflectedAt: string
  sampleData?: Record<string, unknown>[]
  metadata?: Record<string, unknown>
}

export interface SchemaData {
  integrationId: string
  name: string
  provider: string
  status: string
  tableCount: number
  tables: SchemaTable[]
}

export interface CreateFormState {
  name: string
  provider: string
  host: string
  port: string
  username: string
  password: string
  database_name: string
}

export interface RestConnectorItem {
  id: string
  name: string
  baseUrl: string
  authType: 'NONE' | 'BEARER' | 'API_KEY_HEADER' | string
  isActive: boolean
  timeoutMs: number
  createdAt: string
  updatedAt: string
  _count?: {
    endpoints: number
    requestLogs: number
  }
}

export interface RestEndpointItem {
  id: string
  method: string
  path: string
  description: string | null
  parameterSchema: string | null
  sampleRequest: string | null
  sampleResponse: string | null
  isEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface RestConnectorDetail extends RestConnectorItem {
  authConfig?: Record<string, unknown>
  endpoints: RestEndpointItem[]
}

export const EMPTY_FORM: CreateFormState = {
  name: '',
  provider: 'POSTGRESQL',
  host: 'localhost',
  port: '5432',
  username: '',
  password: '',
  database_name: '',
}
