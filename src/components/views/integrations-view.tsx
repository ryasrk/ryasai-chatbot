'use client'

/**
 * IntegrationsView — Dynamic Connector Factory UI (spec §3.1, §3.2, §5.1).
 *
 * Admins register SQL databases and REST API connectors here. Database
 * integrations expose schema reflection and a Text-to-SQL query tester.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Database,
  Globe,
  Plus,
  RefreshCw,
  Trash2,
  Eye,
  Terminal,
  CheckCircle2,
  XCircle,
  Loader2,
  ShieldAlert,
  ChevronDown,
  Server,
  Clock,
  Table2,
  Search,
  Columns3,
  Copy,
  Download,
  Key,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/view-states'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Accordion,
  AccordionContent,
  AccordionTrigger,
  AccordionItem,
} from '@/components/ui/accordion'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { extractError } from '@/lib/extract-error'
import type { Integration, QueryResult } from '@/lib/types'
import { DB_PROVIDER_PRESETS, getDbProviderPreset } from '@/lib/db-provider-presets'

/* ------------------------------------------------------------------ helpers */

function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return 'never'
  }
}

const STATUS_BADGE: Record<
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

interface MaskedConfig {
  host?: string
  port?: number | string
  database_name?: string
  username?: string
  password?: string
  [k: string]: unknown
}

interface SchemaColumn {
  name: string
  type: string
  nullable?: boolean
  primaryKey?: boolean
  description?: string
}

interface SchemaTable {
  id: string
  tableName: string
  columns: SchemaColumn[]
  rowCount: number | null
  reflectedAt: string
  sampleData?: Record<string, unknown>[]
  metadata?: Record<string, unknown>
}

interface SchemaData {
  integrationId: string
  name: string
  provider: string
  status: string
  tableCount: number
  tables: SchemaTable[]
}

interface CreateFormState {
  name: string
  provider: string
  host: string
  port: string
  username: string
  password: string
  database_name: string
}

interface RestConnectorItem {
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

interface RestEndpointItem {
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

interface RestConnectorDetail extends RestConnectorItem {
  authConfig?: Record<string, unknown>
  endpoints: RestEndpointItem[]
}

const EMPTY_FORM: CreateFormState = {
  name: '',
  provider: 'SQLITE_DEMO',
  host: 'localhost',
  port: '5432',
  username: '',
  password: '',
  database_name: '',
}

/* ============================================================ main view */

export function IntegrationsView() {
  const [items, setItems] = useState<Integration[]>([])
  const [restItems, setRestItems] = useState<RestConnectorItem[]>([])
  const [loading, setLoading] = useState(true)
  const [restLoading, setRestLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [restName, setRestName] = useState('')
  const [restBaseUrl, setRestBaseUrl] = useState('')
  const [restAuthType, setRestAuthType] = useState('NONE')
  const [restToken, setRestToken] = useState('')
  const [restBasicUser, setRestBasicUser] = useState('')
  const [restBasicPass, setRestBasicPass] = useState('')
  const [restOauthUrl, setRestOauthUrl] = useState('')
  const [restOauthClientId, setRestOauthClientId] = useState('')
  const [restOauthClientSecret, setRestOauthClientSecret] = useState('')
  const [restOauthScope, setRestOauthScope] = useState('')
  const [restCreating, setRestCreating] = useState(false)
  const [activeTab, setActiveTab] = useState<'database' | 'rest'>('database')
  const [testingId, setTestingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Integration | null>(null)
  const [schemaTarget, setSchemaTarget] = useState<Integration | null>(null)
  const [queryTarget, setQueryTarget] = useState<Integration | null>(null)
  const [restTarget, setRestTarget] = useState<RestConnectorItem | null>(null)

  const fetchList = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const res = await fetch('/api/integrations', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok && json.ok) {
        setItems(json.data as Integration[])
      } else {
        setLoadError(true)
        toast.error(extractError(json.error, 'Failed to load integration list.'))
      }
    } catch (e) {
      setLoadError(true)
      toast.error('Network error while loading integrations.')
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  const fetchRestList = useCallback(async () => {
    setRestLoading(true)
    try {
      const res = await fetch('/api/data-sources/rest-connectors', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok && json.ok) {
        setRestItems(json.items ?? [])
      } else {
        toast.error(extractError(json.error, 'Failed to load REST API connectors.'))
      }
    } catch (e) {
      toast.error('Network error while loading REST API connectors.')
      console.error(e)
    } finally {
      setRestLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRestList()
  }, [fetchRestList])

  const handleTest = async (id: string) => {
    setTestingId(id)
    try {
      const res = await fetch(`/api/integrations/${id}/test`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        toast.error(extractError(json.error, 'Failed to test connection.'))
      } else if (json.ok) {
        toast.success(
          `Connection successful. ${json.tablesCount ?? 0} tables available.`,
        )
        await fetchList()
      } else {
        toast.error(json.message ?? 'Connection failed — check credentials.')
        await fetchList()
      }
    } catch (e) {
      toast.error('Network error while testing connection.')
      console.error(e)
    } finally {
      setTestingId(null)
    }
  }

  const handleToggleIntegration = async (id: string, checked: boolean) => {
    const newStatus = checked ? 'active' : 'inactive'
    try {
      const res = await fetch(`/api/integrations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        toast.error(extractError(json.error, 'Failed to change integration status.'))
        return
      }
      toast.success(
        checked
          ? 'Integration enabled.'
          : 'Integration disabled.',
      )
      await fetchList()
    } catch (e) {
      toast.error('Network error while changing status.')
      console.error(e)
    }
  }

  const handleToggleRestConnector = async (id: string, checked: boolean) => {
    try {
      const res = await fetch(`/api/data-sources/rest-connectors/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: checked }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        toast.error(extractError(json.error, 'Failed to change REST connector status.'))
        return
      }
      toast.success(
        checked
          ? 'REST connector enabled.'
          : 'REST connector disabled.',
      )
      await fetchRestList()
    } catch (e) {
      toast.error('Network error while changing status.')
      console.error(e)
    }
  }

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      const res = await fetch(`/api/integrations/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if ((res.ok && json.ok) || res.status === 404) {
        toast.success(
          res.status === 404
            ? 'Integration no longer exists. List reloaded.'
            : 'Integration deleted successfully.',
        )
        if (schemaTarget?.id === id) setSchemaTarget(null)
        if (queryTarget?.id === id) setQueryTarget(null)
        await fetchList()
      } else {
        toast.error(extractError(json.error, 'Failed to delete integration.'))
      }
    } catch (e) {
      toast.error('Network error while deleting.')
      console.error(e)
    } finally {
      setDeleteTarget(null)
      setDeletingId(null)
    }
  }

  const handleCreateRestConnector = async () => {
    const name = restName.trim()
    const baseUrl = restBaseUrl.trim()
    if (!name || !baseUrl) {
      toast.error('Name and Base URL are required.')
      return
    }
    try { new URL(baseUrl) } catch {
      toast.error('Invalid Base URL.')
      return
    }
    if (restAuthType !== 'NONE' && !restToken.trim() && restAuthType !== 'BASIC' && restAuthType !== 'OAUTH2') {
      toast.error('Token is required for authentication.')
      return
    }
    if (restAuthType === 'BASIC' && !restBasicUser.trim() && !restBasicPass.trim()) {
      toast.error('Username and password are required for Basic Auth.')
      return
    }
    if (restAuthType === 'OAUTH2' && (!restOauthUrl.trim() || !restOauthClientId.trim() || !restOauthClientSecret.trim())) {
      toast.error('Token URL, Client ID, and Client Secret are required for OAuth2.')
      return
    }
    setRestCreating(true)
    try {
      let authConfig: Record<string, unknown> = {}
      if (restAuthType === 'BEARER') {
        authConfig = { token: restToken }
      } else if (restAuthType === 'API_KEY_HEADER') {
        authConfig = { headerName: 'X-API-Key', apiKey: restToken }
      } else if (restAuthType === 'BASIC') {
        authConfig = { username: restBasicUser, password: restBasicPass }
      } else if (restAuthType === 'OAUTH2') {
        authConfig = {
          tokenUrl: restOauthUrl,
          clientId: restOauthClientId,
          clientSecret: restOauthClientSecret,
          ...(restOauthScope.trim() ? { scope: restOauthScope } : {}),
        }
      }
      const res = await fetch('/api/data-sources/rest-connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          baseUrl,
          authType: restAuthType,
          authConfig,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to create connector.'))
      toast.success('REST API connector created.')
      setRestName('')
      setRestBaseUrl('')
      setRestToken('')
      setRestBasicUser('')
      setRestBasicPass('')
      setRestOauthUrl('')
      setRestOauthClientId('')
      setRestOauthClientSecret('')
      setRestOauthScope('')
      setRestAuthType('NONE')
      await fetchRestList()
    } catch (e) {
      toast.error('Failed to create REST API connector', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setRestCreating(false)
    }
  }

  const stats = {
    total: items.length,
    active: items.filter((i) => i.status === 'active').length,
    errorInactive: items.filter((i) => i.status !== 'active').length,
  }

  return (
    <div className="space-y-3">
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2.5">
        <StatCard
          label="Total Databases"
          value={stats.total}
          icon={Server}
          iconClass="text-muted-foreground"
        />
        <StatCard
          label="Active"
          value={stats.active}
          icon={CheckCircle2}
          iconClass="text-success"
        />
        <StatCard
          label="Error / Inactive"
          value={stats.errorInactive}
          icon={XCircle}
          iconClass="text-destructive"
        />
      </div>

      <Tabs defaultValue="database" onValueChange={(v) => setActiveTab(v as 'database' | 'rest')} className="min-h-[500px]">
        <div className="flex items-center justify-between gap-2">
          <TabsList className="w-max">
            <TabsTrigger value="database" className="gap-1.5 text-xs">
              <Server className="h-3.5 w-3.5" />
              Database
            </TabsTrigger>
            <TabsTrigger value="rest" className="gap-1.5 text-xs">
              <Globe className="h-3.5 w-3.5" />
              REST API
            </TabsTrigger>
          </TabsList>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" onClick={fetchList} disabled={loading}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
            {activeTab === 'database' && (
              <Button onClick={() => setCreateOpen(true)} size="sm">
                <Plus className="h-3.5 w-3.5" />
                Add Database
              </Button>
            )}
          </div>
        </div>

        <TabsContent value="database" className="mt-2">
      {loading ? (
        <LoadingState label="Loading integrations…" />
      ) : loadError ? (
        <ErrorState message="Failed to load integrations." onRetry={fetchList} />
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Database}
              title="No databases registered yet"
              hint="Click Add Database to start connecting SQL data sources."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {items.map((it) => (
            <IntegrationCard
              key={it.id}
              integration={it}
              onTest={() => handleTest(it.id)}
              testing={testingId === it.id}
              deleting={deletingId === it.id}
              onSchema={() => setSchemaTarget(it)}
              onQuery={() => setQueryTarget(it)}
              onDelete={() => setDeleteTarget(it)}
              onToggle={(checked) => handleToggleIntegration(it.id, checked)}
            />
          ))}
        </div>
      )}
        </TabsContent>

        <TabsContent value="rest" className="mt-2">
      {/* REST API Connectors */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xs flex items-center gap-2">
            <Globe className="h-4 w-4" />
            REST API Connectors
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Register the base URL of an external system, then whitelist endpoints that can be called by the chatbot.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
            <Input
              value={restName}
              onChange={(e) => setRestName(e.target.value)}
              placeholder="Connector name"
              className="md:col-span-1"
            />
            <Input
              value={restBaseUrl}
              onChange={(e) => setRestBaseUrl(e.target.value)}
              placeholder="https://api.example.com"
              className="md:col-span-2 font-mono text-sm"
            />
            <Select value={restAuthType} onValueChange={setRestAuthType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">No Auth</SelectItem>
                <SelectItem value="BEARER">Bearer Token</SelectItem>
                <SelectItem value="API_KEY_HEADER">API Key Header</SelectItem>
                <SelectItem value="BASIC">Basic Auth</SelectItem>
                <SelectItem value="OAUTH2">OAuth2 (Client Credentials)</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={handleCreateRestConnector}
              disabled={restCreating || !restName.trim() || !restBaseUrl.trim()}
            >
              {restCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add REST
            </Button>
          </div>

          {(restAuthType === 'BEARER' || restAuthType === 'API_KEY_HEADER') && (
            <Input
              value={restToken}
              onChange={(e) => setRestToken(e.target.value)}
              placeholder={restAuthType === 'BEARER' ? 'Bearer token' : 'API key'}
              type="password"
              className="font-mono text-sm"
            />
          )}

          {restAuthType === 'BASIC' && (
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={restBasicUser}
                onChange={(e) => setRestBasicUser(e.target.value)}
                placeholder="Username"
                className="font-mono text-sm"
              />
              <Input
                value={restBasicPass}
                onChange={(e) => setRestBasicPass(e.target.value)}
                placeholder="Password"
                type="password"
                className="font-mono text-sm"
              />
            </div>
          )}

          {restAuthType === 'OAUTH2' && (
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
              <Input
                value={restOauthUrl}
                onChange={(e) => setRestOauthUrl(e.target.value)}
                placeholder="Token URL (https://auth.example.com/oauth/token)"
                className="font-mono text-sm"
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={restOauthClientId}
                  onChange={(e) => setRestOauthClientId(e.target.value)}
                  placeholder="Client ID"
                  className="font-mono text-sm"
                />
                <Input
                  value={restOauthClientSecret}
                  onChange={(e) => setRestOauthClientSecret(e.target.value)}
                  placeholder="Client Secret"
                  type="password"
                  className="font-mono text-sm"
                />
              </div>
              <Input
                value={restOauthScope}
                onChange={(e) => setRestOauthScope(e.target.value)}
                placeholder="Scope (optional, e.g. read:api)"
                className="font-mono text-sm"
              />
            </div>
          )}

          {restLoading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading REST API connectors...
            </div>
          ) : restItems.length === 0 ? (
            <div className="rounded-md border border-dashed py-8 text-center text-xs text-muted-foreground">
              No REST API connectors yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {restItems.map((connector) => (
                <div key={connector.id} className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{connector.name}</div>
                      <div className="font-mono text-xs text-muted-foreground truncate">
                        {connector.baseUrl}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs font-medium text-muted-foreground">
                        {connector.isActive ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                      <Switch
                        checked={connector.isActive}
                        onCheckedChange={(checked) =>
                          handleToggleRestConnector(connector.id, checked)
                        }
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{connector.authType}</Badge>
                    <Badge variant="outline">{connector._count?.endpoints ?? 0} endpoint</Badge>
                    <Badge variant="outline">{connector._count?.requestLogs ?? 0} request log</Badge>
                    <Badge variant="outline">{connector.timeoutMs}ms timeout</Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRestTarget(connector)}
                    className="w-full"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Manage Endpoints
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>

      {/* Create dialog */}
      <CreateIntegrationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false)
          fetchList()
        }}
      />

      {/* Schema viewer */}
      <SchemaViewerSheet
        integration={schemaTarget}
        onClose={() => setSchemaTarget(null)}
      />

      <RestConnectorSheet
        connector={restTarget}
        onClose={() => setRestTarget(null)}
        onChanged={fetchRestList}
      />

      {/* Query tester */}
      <QueryTesterDialog
        integration={queryTarget}
        onClose={() => setQueryTarget(null)}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this integration?</AlertDialogTitle>
            <AlertDialogDescription>
              Integration <strong>{deleteTarget?.name}</strong> will be permanently
              deleted along with its reflected schema. This action cannot be
              undone and is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && handleDelete(deleteTarget.id)}
              disabled={!!deletingId}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {deletingId ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* -------------------------------------------------------------- stat card */

function StatCard({
  label,
  value,
  icon: Icon,
  iconClass,
}: {
  label: string
  value: number
  icon: typeof Server
  iconClass: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-lg font-semibold leading-tight">{value}</div>
          <div className="text-xs text-muted-foreground truncate">{label}</div>
        </div>
        <Icon className={cn('h-4 w-4 shrink-0', iconClass)} />
      </CardContent>
    </Card>
  )
}

/* ----------------------------------------------------- integration card */

function IntegrationCard({
  integration,
  onTest,
  testing,
  deleting,
  onSchema,
  onQuery,
  onDelete,
  onToggle,
}: {
  integration: Integration
  onTest: () => void
  testing: boolean
  deleting?: boolean
  onSchema: () => void
  onQuery: () => void
  onDelete: () => void
  onToggle: (checked: boolean) => void
}) {
  const [configOpen, setConfigOpen] = useState(false)
  const [config, setConfig] = useState<MaskedConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [toggling, setToggling] = useState(false)

  const fetchConfig = async () => {
    setConfigLoading(true)
    try {
      const res = await fetch(`/api/integrations/${integration.id}`, {
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok && json.ok) {
        setConfig(json.data.config as MaskedConfig)
      } else {
        toast.error(extractError(json.error, 'Failed to load configuration.'))
      }
    } catch {
      toast.error('Network error while loading configuration.')
    } finally {
      setConfigLoading(false)
    }
  }

  const isDb = integration.type === 'DATABASE'
  const Icon = isDb ? Database : Globe
  const status = STATUS_BADGE[integration.status] ?? STATUS_BADGE.error
  const lastOk = integration.lastTestOk
  const isActive = integration.status === 'active'

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-xs truncate">{integration.name}</CardTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="text-xs">
                {integration.provider}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {integration.type}
              </Badge>
              <Badge variant="outline" className={cn('text-xs', status.className)}>
                {status.label}
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">
                {isActive ? 'ACTIVE' : 'INACTIVE'}
              </span>
            </div>
            <Switch
              checked={isActive}
              disabled={toggling}
              onCheckedChange={async (checked) => {
                setToggling(true)
                try {
                  await onToggle(checked)
                } finally {
                  setToggling(false)
                }
              }}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-3">
        {/* meta row */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>Last tested:</span>
          </div>
          <div className="flex items-center gap-1.5 justify-end">
            {lastOk === true && (
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            )}
            {lastOk === false && (
              <XCircle className="h-3.5 w-3.5 text-destructive" />
            )}
            <span className="text-muted-foreground truncate">
              {timeAgo(integration.lastTestedAt)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Table2 className="h-3.5 w-3.5" />
            <span>Indexed tables:</span>
          </div>
          <div className="text-right font-medium">
            {integration.tableCount ?? 0} tables
          </div>
        </div>

        {/* masked config collapsible */}
        <details
          className="group rounded-md border bg-muted/30 px-3 py-2 text-xs"
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) fetchConfig()
            setConfigOpen((e.currentTarget as HTMLDetailsElement).open)
          }}
        >
          <summary className="cursor-pointer flex items-center justify-between text-muted-foreground hover:text-foreground transition-colors select-none">
            <span className="font-medium">Configuration (encrypted)</span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                configOpen && 'rotate-180',
              )}
            />
          </summary>
          <div className="mt-2 space-y-1">
            {configLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading…
              </div>
            ) : config ? (
              <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">Host</span>
                <span className="font-mono truncate">{String(config.host ?? '-')}</span>
                <span className="text-muted-foreground">Port</span>
                <span className="font-mono truncate">{String(config.port ?? '-')}</span>
                <span className="text-muted-foreground">Database</span>
                <span className="font-mono truncate">{String(config.database_name ?? '-')}</span>
                <span className="text-muted-foreground">Username</span>
                <span className="font-mono truncate">{String(config.username ?? '-')}</span>
                <span className="text-muted-foreground">Password</span>
                <span className="font-mono">••••••••</span>
              </div>
            ) : (
              <div className="text-muted-foreground">Not loaded yet.</div>
            )}
          </div>
        </details>

        {/* action buttons */}
        <div className="mt-auto grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={onTest}
            disabled={testing}
            className="text-xs"
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Test Connection
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onSchema}
            className="text-xs"
          >
            <Eye className="h-3.5 w-3.5" />
            Schema
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onQuery}
            className="text-xs"
          >
            <Terminal className="h-3.5 w-3.5" />
            Query
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {deleting ? 'Deleting' : 'Delete'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------ create integration */

function CreateIntegrationDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: () => void
}) {
  const [form, setForm] = useState<CreateFormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const preset = getDbProviderPreset(form.provider)
  const isDemo = form.provider === 'SQLITE_DEMO'
  const needsConnectionString = preset?.needsConnectionString ?? false

  const update = (k: keyof CreateFormState, v: string) =>
    setForm((f) => ({ ...f, [k]: v }))

  const handleProviderChange = (providerId: string) => {
    const p = getDbProviderPreset(providerId)
    setForm((f) => ({
      ...f,
      provider: providerId,
      port: p && p.defaultPort > 0 ? String(p.defaultPort) : f.port,
    }))
  }

  const validate = (): boolean => {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = 'Name is required.'
    if (!form.provider) e.provider = 'Provider is required.'
    if (!isDemo) {
      if (needsConnectionString) {
        if (!form.database_name.trim()) e.database_name = 'Connection string is required.'
      } else {
        if (!form.host.trim()) e.host = 'Host is required.'
        if (!form.database_name.trim()) e.database_name = 'Database is required.'
        if (!form.username.trim()) e.username = 'Username is required.'
        if (!form.password) e.password = 'Password is required.'
      }
    }
    if (form.port && !/^\d+$/.test(form.port)) e.port = 'Port must be a number.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return
    setSubmitting(true)
    try {
      let config: Record<string, unknown>
      if (isDemo) {
        config = {
          host: 'demo',
          port: 0,
          database_name: 'demo_erp',
          username: 'demo',
          password: 'demo',
        }
      } else if (needsConnectionString) {
        config = { connectionString: form.database_name.trim() }
      } else {
        config = {
          host: form.host.trim(),
          port: Number(form.port) || 0,
          username: form.username.trim(),
          password: form.password,
          database_name: form.database_name.trim(),
        }
      }

      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          type: 'DATABASE',
          provider: form.provider,
          config,
        }),
      })
      const json = await res.json()
      if (res.ok && json.ok) {
        toast.success('Integration created successfully & schema indexed.')
        setForm(EMPTY_FORM)
        setErrors({})
        onCreated()
      } else {
        toast.error(extractError(json.error, 'Failed to create integration.'))
      }
    } catch (e) {
      toast.error('Network error while creating integration.')
      console.error(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!submitting) {
          onOpenChange(o)
          if (!o) {
            setForm(EMPTY_FORM)
            setErrors({})
          }
        }
      }}
    >
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Database</DialogTitle>
          <DialogDescription>
            Register a SQL database connection. The system will encrypt credentials,
            test the connection, and reflect the schema automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="int-name">
              Integration Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="int-name"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="e.g. ERP Production"
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="int-provider">Database Provider</Label>
            <Select
              value={form.provider}
              onValueChange={handleProviderChange}
            >
              <SelectTrigger id="int-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DB_PROVIDER_PRESETS.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.provider && (
            <p className="text-xs text-muted-foreground bg-muted/60 border rounded-md px-3 py-2">
              {preset?.hint ?? 'Provider'}
              {preset?.sslByDefault && (
                <span className="block mt-1 text-warning">
                  SSL is recommended for this provider.
                </span>
              )}
              {isDemo && (
                <span className="block mt-1 text-success">
                  Use SQLITE_DEMO only for internal validation before a production connection is available.
                </span>
              )}
            </p>
          )}

          {/* Config fields — only shown for non-DEMO providers */}
          {!isDemo && needsConnectionString && (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
              <div className="space-y-1.5">
                <Label htmlFor="int-connstring">
                  Connection String <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="int-connstring"
                  value={form.database_name}
                  onChange={(e) => update('database_name', e.target.value)}
                  placeholder="mongodb+srv://user:pass@cluster/db?retryWrites=true&w=majority"
                  className="font-mono text-xs min-h-[80px]"
                />
                {errors.database_name && (
                  <p className="text-xs text-destructive">{errors.database_name}</p>
                )}
              </div>
            </div>
          )}
          {!isDemo && !needsConnectionString && (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="int-host">Host</Label>
                  <Input
                    id="int-host"
                    value={form.host}
                    onChange={(e) => update('host', e.target.value)}
                    placeholder="localhost"
                  />
                  {errors.host && (
                    <p className="text-xs text-destructive">{errors.host}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="int-port">Port</Label>
                  <Input
                    id="int-port"
                    inputMode="numeric"
                    value={form.port}
                    onChange={(e) => update('port', e.target.value)}
                    placeholder={preset ? String(preset.defaultPort) : '5432'}
                  />
                  {errors.port && (
                    <p className="text-xs text-destructive">{errors.port}</p>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="int-db">Database Name</Label>
                <Input
                  id="int-db"
                  value={form.database_name}
                  onChange={(e) => update('database_name', e.target.value)}
                  placeholder="erp_db"
                />
                {errors.database_name && (
                  <p className="text-xs text-destructive">{errors.database_name}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="int-user">Username</Label>
                  <Input
                    id="int-user"
                    value={form.username}
                    onChange={(e) => update('username', e.target.value)}
                    placeholder="db_user"
                  />
                  {errors.username && (
                    <p className="text-xs text-destructive">{errors.username}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="int-pass">Password</Label>
                  <Input
                    id="int-pass"
                    type="password"
                    value={form.password}
                    onChange={(e) => update('password', e.target.value)}
                    placeholder="••••••••"
                  />
                  {errors.password && (
                    <p className="text-xs text-destructive">{errors.password}</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating & testing…
              </>
            ) : (
              'Create & Test Connection'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ----------------------------------------------------- schema viewer */

function generateCreateTable(table: SchemaTable): string {
  const cols = table.columns.map((c) => {
    let line = `  "${c.name}" ${c.type || 'TEXT'}`
    if (c.primaryKey) line += ' PRIMARY KEY'
    if (c.nullable === false) line += ' NOT NULL'
    return line
  })
  return `CREATE TABLE "${table.tableName}" (\n${cols.join(',\n')}\n);`
}

function SchemaIconAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-muted cursor-pointer transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation()
              e.preventDefault()
              onClick()
            }
          }}
        >
          <Icon className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function SchemaTableDetails({
  table,
  columnSearch,
}: {
  table: SchemaTable
  columnSearch: string
}) {
  const colQ = columnSearch.trim().toLowerCase()
  const hasColMatch = colQ.length > 0
  const hasDescriptions = table.columns.some((c) => c.description)

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
          Columns
        </h4>
        <div className="rounded-none border border-border/60 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-7 text-xs">Name</TableHead>
                <TableHead className="h-7 text-xs">Type</TableHead>
                <TableHead className="h-7 text-xs w-16">Null</TableHead>
                <TableHead className="h-7 text-xs w-10">PK</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.columns.map((c, i) => {
                const isMatch =
                  hasColMatch && c.name.toLowerCase().includes(colQ)
                return (
                  <TableRow
                    key={i}
                    className={isMatch ? 'bg-primary/10' : undefined}
                  >
                    <TableCell className="py-1.5 text-xs font-mono">
                      <div className="flex items-center gap-1.5">
                        {c.primaryKey && (
                          <Key className="h-3 w-3 text-warning shrink-0" />
                        )}
                        <span>{c.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="py-1.5">
                      <Badge
                        variant="outline"
                        className="text-xs px-1.5 py-0 font-mono"
                      >
                        {c.type || '-'}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-1.5">
                      {c.nullable !== undefined ? (
                        <Badge
                          variant={c.nullable ? 'secondary' : 'destructive'}
                          className="text-xs px-1.5 py-0"
                        >
                          {c.nullable ? 'YES' : 'NO'}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-1.5">
                      {c.primaryKey ? (
                        <Key className="h-3 w-3 text-warning" />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        {hasDescriptions && (
          <div className="mt-1.5 space-y-0.5">
            {table.columns
              .filter((c) => c.description)
              .map((c, i) => (
                <div
                  key={i}
                  className="text-xs text-muted-foreground"
                >
                  <span className="font-mono">{c.name}</span>: {c.description}
                </div>
              ))}
          </div>
        )}
      </div>

      {table.sampleData && table.sampleData.length > 0 && (
        <>
          <Separator />
          <div>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Sample Data ({table.sampleData.length} rows)
            </h4>
            <div className="rounded-none border border-border/60 overflow-auto max-h-32">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    {Object.keys(table.sampleData[0]).map((k) => (
                      <TableHead
                        key={k}
                        className="h-6 text-xs font-mono whitespace-nowrap"
                      >
                        {k}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {table.sampleData.map((row, i) => (
                    <TableRow key={i}>
                      {Object.values(row).map((v, j) => (
                        <TableCell
                          key={j}
                          className="py-1 text-xs font-mono whitespace-nowrap"
                        >
                          {v === null || v === undefined ? '—' : String(v)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}

      <Separator />
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
          Metadata
        </h4>
        <div className="space-y-0.5 text-xs">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-28">Row count</span>
            <span className="font-mono">{table.rowCount ?? '?'}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-28">Reflected</span>
            <span>{timeAgo(table.reflectedAt)}</span>
          </div>
          {table.metadata &&
            Object.entries(table.metadata).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="text-muted-foreground w-28">{k}</span>
                <span className="font-mono">{String(v)}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}

function SchemaViewerSheet({
  integration,
  onClose,
}: {
  integration: Integration | null
  onClose: () => void
}) {
  return (
    <Sheet open={!!integration} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-[720px] w-full flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Table2 className="h-4 w-4" />
            Schema {integration?.name ?? ''}
          </SheetTitle>
          <SheetDescription>
            Cached table &amp; column reflection from the integration.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 mt-2">
          {integration && (
            <SchemaViewerContent
              key={integration.id}
              integration={integration}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SchemaViewerContent({
  integration,
}: {
  integration: Integration
}) {
  const [data, setData] = useState<SchemaData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tableSearch, setTableSearch] = useState('')
  const [columnSearch, setColumnSearch] = useState('')
  const [openItems, setOpenItems] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/integrations/${integration.id}/schema`, { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json()
        if (cancelled) return
        if (r.ok && j.ok) setData(j.data as SchemaData)
        else setError(extractError(j.error, 'Failed to load schema.'))
      })
      .catch(() => {
        if (!cancelled) setError('Network error while loading schema.')
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [integration.id])

  const filteredTables = useMemo(() => {
    if (!data) return []
    const q = tableSearch.trim().toLowerCase()
    const colQ = columnSearch.trim().toLowerCase()
    return data.tables.filter((t) => {
      if (q && !t.tableName.toLowerCase().includes(q)) return false
      if (
        colQ &&
        !t.columns.some((c) => c.name.toLowerCase().includes(colQ))
      )
        return false
      return true
    })
  }, [data, tableSearch, columnSearch])

  const allIds = useMemo(
    () => filteredTables.map((t) => t.id),
    [filteredTables],
  )
  const allOpen =
    allIds.length > 0 && allIds.every((id) => openItems.includes(id))

  const handleExpandAll = () => setOpenItems(allIds)
  const handleCollapseAll = () => setOpenItems([])

  const handleDownload = () => {
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `schema-${data.name}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleCopyName = async (name: string) => {
    try { await navigator.clipboard.writeText(name); toast.success('Table name copied') } catch { toast.error('Failed to copy') }
  }

  const handleCopyCreateTable = async (table: SchemaTable) => {
    try { await navigator.clipboard.writeText(generateCreateTable(table)); toast.success('CREATE TABLE schema copied') } catch { toast.error('Failed to copy') }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading schema…
      </div>
    )
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (!data) {
    return (
      <div className="text-xs text-muted-foreground py-8 text-center">
        No data.
      </div>
    )
  }
  if (data.tables.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-8 text-center">
        Schema is empty. Run <strong>Test Connection</strong> to
        reflect tables.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="space-y-2 pb-2.5 border-b border-border/70">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {filteredTables.length} of {data.tableCount} tables ·{' '}
            <Badge
              variant="outline"
              className="text-xs px-1.5 py-0"
            >
              {data.provider}
            </Badge>
          </span>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  onClick={allOpen ? handleCollapseAll : handleExpandAll}
                >
                  {allOpen ? (
                    <ChevronsDownUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronsUpDown className="h-3.5 w-3.5" />
                  )}
                  {allOpen ? 'Collapse' : 'Expand'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {allOpen ? 'Collapse all tables' : 'Expand all tables'}
              </TooltipContent>
            </Tooltip>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs gap-1"
              onClick={handleDownload}
            >
              <Download className="h-3.5 w-3.5" />
              JSON
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search tables…"
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <div className="relative flex-1">
            <Columns3 className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search columns…"
              value={columnSearch}
              onChange={(e) => setColumnSearch(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0 mt-2 pr-2">
        {filteredTables.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center">
            No matching tables.
          </div>
        ) : (
          <Accordion
            type="multiple"
            value={openItems}
            onValueChange={setOpenItems}
            className="w-full space-y-2"
          >
            {filteredTables.map((t) => (
              <AccordionItem
                key={t.id}
                value={t.id}
                className="rounded-none border border-border/70 bg-card/50 overflow-hidden"
              >
                <div className="flex items-center gap-1 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <AccordionTrigger className="py-0 px-0 hover:no-underline">
                      <div className="flex items-center gap-2 min-w-0">
                        <Table2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-mono text-sm font-medium truncate">
                          {t.tableName}
                        </span>
                        <Badge
                          variant="secondary"
                          className="text-xs px-1.5 py-0 shrink-0"
                        >
                          {t.rowCount ?? '?'} rows
                        </Badge>
                        <Badge
                          variant="outline"
                          className="text-xs px-1.5 py-0 shrink-0"
                        >
                          {t.columns.length} columns
                        </Badge>
                      </div>
                    </AccordionTrigger>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <SchemaIconAction
                      icon={Copy}
                      label="Copy table name"
                      onClick={() => handleCopyName(t.tableName)}
                    />
                    <SchemaIconAction
                      icon={Code2}
                      label="Copy CREATE TABLE"
                      onClick={() => handleCopyCreateTable(t)}
                    />
                  </div>
                </div>
                <AccordionContent className="px-3 pb-3">
                  <SchemaTableDetails
                    table={t}
                    columnSearch={columnSearch}
                  />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </ScrollArea>
    </div>
  )
}

/* --------------------------------------------- REST connector manager */

function RestConnectorSheet({
  connector,
  onClose,
  onChanged,
}: {
  connector: RestConnectorItem | null
  onClose: () => void
  onChanged: () => void
}) {
  return (
    <Sheet open={!!connector} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-[680px] w-full flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4" />
            REST API — {connector?.name ?? ''}
          </SheetTitle>
          <SheetDescription>
            Manage endpoint whitelist and test requests that can be used by the chatbot.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 mt-2">
          {connector && (
            <RestConnectorContent
              key={connector.id}
              connector={connector}
              onChanged={onChanged}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function RestConnectorContent({
  connector,
  onChanged,
}: {
  connector: RestConnectorItem
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<RestConnectorDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [testMethod, setTestMethod] = useState('GET')
  const [testPath, setTestPath] = useState('')
  const [testQuery, setTestQuery] = useState('')
  const [testBody, setTestBody] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<unknown>(null)
  const [deletingEndpointId, setDeletingEndpointId] = useState<string | null>(null)

  const fetchDetail = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/data-sources/rest-connectors/${connector.id}`, {
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok && json.ok) {
        setDetail(json.data as RestConnectorDetail)
      } else {
        setError(extractError(json.error, 'Failed to load REST connector.'))
      }
    } catch (e) {
      console.error(e)
      setError('Network error while loading REST connector.')
    } finally {
      setLoading(false)
    }
  }, [connector.id])

  useEffect(() => {
    fetchDetail()
  }, [fetchDetail])

  const handleToggleActive = async (checked: boolean) => {
    try {
      const res = await fetch(`/api/data-sources/rest-connectors/${connector.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: checked }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        toast.error(extractError(json.error, 'Failed to change status.'))
        return
      }
      toast.success(checked ? 'REST connector enabled.' : 'REST connector disabled.')
      setDetail((prev) => (prev ? { ...prev, isActive: checked } : prev))
      onChanged()
    } catch (e) {
      toast.error('Network error while changing status.')
      console.error(e)
    }
  }

  const handleAddEndpoint = async () => {
    const trimmedPath = path.trim()
    if (!trimmedPath) {
      toast.error('Endpoint path is required.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/data-sources/rest-connectors/${connector.id}/endpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          path: trimmedPath,
          description: description.trim() || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to add endpoint.'))
      toast.success('Endpoint whitelist added.')
      setPath('')
      setDescription('')
      await fetchDetail()
      onChanged()
    } catch (e) {
      toast.error('Failed to add endpoint', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleTestEndpoint = async () => {
    const trimmedPath = testPath.trim()
    if (!trimmedPath) {
      toast.error('Test path is required.')
      return
    }

    let parsedBody: unknown
    if (testBody.trim()) {
      try {
        parsedBody = JSON.parse(testBody)
      } catch {
        toast.error('Body must be valid JSON.')
        return
      }
    }

    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(`/api/data-sources/rest-connectors/${connector.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: testMethod,
          path: trimmedPath,
          query: parseQueryPairs(testQuery),
          body: parsedBody,
        }),
      })
      const json = await res.json()
      setTestResult(json)
      if (res.ok && json.ok) toast.success('REST endpoint tested successfully.')
      else toast.error(extractError(json.error, 'REST endpoint failed to test.'))
    } catch (e) {
      console.error(e)
      toast.error('Network error while testing endpoint.')
    } finally {
      setTesting(false)
    }
  }

  const handleDeleteEndpoint = async (endpointId: string) => {
    setDeletingEndpointId(endpointId)
    try {
      const res = await fetch(
        `/api/data-sources/rest-connectors/${connector.id}/endpoints/${endpointId}`,
        { method: 'DELETE' },
      )
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to delete endpoint.'))
      toast.success('Endpoint whitelist deleted.')
      await fetchDetail()
      onChanged()
    } catch (e) {
      toast.error('Failed to delete endpoint', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setDeletingEndpointId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading REST connector...
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  if (!detail) return null

  return (
    <ScrollArea className="h-full pr-2">
      <div className="space-y-4">
        <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium">{detail.name}</div>
              <div className="font-mono text-xs text-muted-foreground truncate">
                {detail.baseUrl}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-medium text-muted-foreground">
                {detail.isActive ? 'ACTIVE' : 'INACTIVE'}
              </span>
              <Switch
                checked={detail.isActive}
                onCheckedChange={handleToggleActive}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">{detail.authType}</Badge>
            <Badge variant="outline">{detail.timeoutMs}ms timeout</Badge>
            <Badge variant="outline">{detail.endpoints.length} endpoint</Badge>
          </div>
        </div>

        <div className="rounded-lg border p-3 space-y-3">
          <div>
            <div className="text-sm font-medium">Add Endpoint Whitelist</div>
            <p className="text-xs text-muted-foreground">
              Only endpoints in this list can be called by test requests and the chatbot router.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="sm:col-span-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/customers"
              className="sm:col-span-4 font-mono text-sm"
            />
          </div>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description for AI, e.g. fetch list of active customers"
          />
          <Button
            onClick={handleAddEndpoint}
            disabled={submitting || !path.trim()}
            size="sm"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add Endpoint
          </Button>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Method</TableHead>
                <TableHead className="text-xs">Path</TableHead>
                <TableHead className="text-xs">Description</TableHead>
                <TableHead className="text-xs text-right">Status</TableHead>
                <TableHead className="text-xs text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.endpoints.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-8">
                    No endpoint whitelist yet.
                  </TableCell>
                </TableRow>
              ) : (
                detail.endpoints.map((endpoint) => (
                  <TableRow
                    key={endpoint.id}
                    className="cursor-pointer"
                    onClick={() => {
                      setTestMethod(endpoint.method)
                      setTestPath(endpoint.path)
                    }}
                  >
                    <TableCell className="font-mono text-xs">{endpoint.method}</TableCell>
                    <TableCell className="font-mono text-xs">{endpoint.path}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {endpoint.description ?? '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={endpoint.isEnabled ? 'default' : 'secondary'}>
                        {endpoint.isEnabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        disabled={deletingEndpointId === endpoint.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteEndpoint(endpoint.id)
                        }}
                      >
                        {deletingEndpointId === endpoint.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="rounded-lg border p-3 space-y-3">
          <div>
            <div className="text-sm font-medium">Test Endpoint</div>
            <p className="text-xs text-muted-foreground">
              Click an endpoint in the table to fill method and path, then run the request.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
            <Select value={testMethod} onValueChange={setTestMethod}>
              <SelectTrigger className="sm:col-span-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={testPath}
              onChange={(e) => setTestPath(e.target.value)}
              placeholder="/customers"
              className="sm:col-span-4 font-mono text-sm"
            />
          </div>
          <Input
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            placeholder="limit=10&status=active"
            className="font-mono text-sm"
          />
          {testMethod !== 'GET' && (
            <Textarea
              value={testBody}
              onChange={(e) => setTestBody(e.target.value)}
              rows={4}
              placeholder='{"name":"Example"}'
              className="font-mono text-xs resize-none"
            />
          )}
          <Button
            onClick={handleTestEndpoint}
            disabled={testing || !testPath.trim()}
            size="sm"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Terminal className="h-4 w-4" />}
            Run Test
          </Button>
          {testResult !== null && (
            <pre className="max-h-[260px] overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
              <code>{JSON.stringify(testResult, null, 2)}</code>
            </pre>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

function parseQueryPairs(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw.trim().replace(/^\?/, ''))
  return Object.fromEntries(params.entries())
}

/* ------------------------------------------------- query tester */

const SAMPLE_QUERY = 'Show 5 products with the highest price'

function QueryTesterDialog({
  integration,
  onClose,
}: {
  integration: Integration | null
  onClose: () => void
}) {
  return (
    <Dialog open={!!integration} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[760px] max-h-[92vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            Query Tester — {integration?.name ?? ''}
          </DialogTitle>
          <DialogDescription>
            Ask a natural language question. The system will convert it to SQL,
            validate via AST guardrail, then execute it.
          </DialogDescription>
        </DialogHeader>
        {integration && (
          <QueryTesterContent key={integration.id} integration={integration} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function QueryTesterContent({ integration }: { integration: Integration }) {
  const [query, setQuery] = useState(SAMPLE_QUERY)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleRun = async () => {
    const q = query.trim()
    if (!q) {
      toast.error('Question cannot be empty.')
      return
    }
    setRunning(true)
    setResult(null)
    setErrorMsg(null)
    try {
      const res = await fetch(`/api/integrations/${integration.id}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ naturalQuery: q }),
      })
      const json = (await res.json()) as QueryResult & {
        error?: string
        reason?: string
        generatedSql?: string
      }
      if (res.ok && json.ok) {
        setResult(json)
      } else if (res.status === 403) {
        // guardrail block — keep the result shape so UI can render it
        setResult({
          ok: false,
          reason: json.reason ?? 'Query rejected by security guardrail.',
          generatedSql: json.generatedSql,
        })
      } else {
        setErrorMsg(
          extractError(
            json.error,
            json.reason ??
              'Sorry, an error occurred while processing the query.',
          ),
        )
      }
    } catch (e) {
      console.error(e)
      setErrorMsg('Network error while running the query.')
    } finally {
      setRunning(false)
    }
  }

  const rows = result?.rows ?? []
  const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : []

  return (
        <div className="space-y-3 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="nlq">Question (Natural Language)</Label>
            <Textarea
              id="nlq"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              rows={3}
              placeholder={SAMPLE_QUERY}
              className="resize-none"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Pre-fill: example query. Edit as needed.
            </p>
            <Button onClick={handleRun} disabled={running || !query.trim()}>
              {running ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Terminal className="h-4 w-4" />
                  Run
                </>
              )}
            </Button>
          </div>

          {/* Guardrail block */}
          {result && !result.ok && result.reason && (
            <Alert variant="destructive">
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>Query Rejected by Guardrail</AlertTitle>
              <AlertDescription className="space-y-1">
                <p>{result.reason}</p>
                {result.generatedSql && (
                  <pre className="mt-2 text-xs bg-rose-950/20 dark:bg-rose-950/40 rounded-md p-2 overflow-x-auto">
                    <code>{result.generatedSql}</code>
                  </pre>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* Generic error */}
          {errorMsg && (
            <Alert variant="destructive">
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>An Error Occurred</AlertTitle>
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          )}

          {/* Success result */}
          {result && result.ok && (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    Generated SQL
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary" className="text-xs">
                      {result.rowCount ?? 0} rows
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {result.executionMs ?? 0} ms
                    </Badge>
                  </div>
                </div>
                <pre className="text-xs bg-background border rounded-md p-2 overflow-x-auto">
                  <code>{result.sql}</code>
                </pre>
                {result.explanation && (
                  <p className="text-xs text-muted-foreground">
                    {result.explanation}
                  </p>
                )}
              </div>

              {rows.length > 0 ? (
                <div className="rounded-md border overflow-hidden">
                  <div className="max-h-[320px] overflow-auto">
                    <Table>
                      <TableHeader className="sticky top-0 bg-background z-10">
                        <TableRow>
                          {columns.map((c) => (
                            <TableHead
                              key={c}
                              className="text-xs font-mono whitespace-nowrap"
                            >
                              {c}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((r, i) => (
                          <TableRow key={i}>
                            {columns.map((c) => (
                              <TableCell
                                key={c}
                                className="text-xs font-mono whitespace-nowrap"
                              >
                                {formatCell((r as Record<string, unknown>)[c])}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  Query executed successfully but returned no rows.
                </p>
              )}
            </div>
          )}
        </div>
  )
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}
