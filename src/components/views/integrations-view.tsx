'use client'

/**
 * IntegrationsView — Dynamic Connector Factory UI (spec §3.1, §3.2, §5.1).
 *
 * Admins register SQL databases and REST API connectors here. Database
 * integrations expose schema reflection and a Text-to-SQL query tester.
 */

import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
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
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { cn } from '@/lib/utils'
import type { Integration, IntegrationSchemaRow, QueryResult } from '@/lib/types'

/* ------------------------------------------------------------------ helpers */

function timeAgo(iso: string | null): string {
  if (!iso) return 'belum pernah'
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: idLocale })
  } catch {
    return 'belum pernah'
  }
}

const STATUS_BADGE: Record<
  Integration['status'],
  { label: string; className: string }
> = {
  active: {
    label: 'Aktif',
    className:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  },
  inactive: {
    label: 'Nonaktif',
    className:
      'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  },
  error: {
    label: 'Error',
    className:
      'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  },
}

const PROVIDER_HINT: Record<string, string> = {
  SQLITE_DEMO: 'SQLite sample dataset untuk validasi internal',
  POSTGRESQL: 'Production PostgreSQL',
  MYSQL: 'Production MySQL / MariaDB',
  MSSQL: 'Microsoft SQL Server',
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

interface SchemaData {
  integrationId: string
  name: string
  provider: string
  status: string
  tableCount: number
  tables: IntegrationSchemaRow[]
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
  const [createOpen, setCreateOpen] = useState(false)
  const [restName, setRestName] = useState('')
  const [restBaseUrl, setRestBaseUrl] = useState('')
  const [restAuthType, setRestAuthType] = useState('NONE')
  const [restToken, setRestToken] = useState('')
  const [restCreating, setRestCreating] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Integration | null>(null)
  const [schemaTarget, setSchemaTarget] = useState<Integration | null>(null)
  const [queryTarget, setQueryTarget] = useState<Integration | null>(null)
  const [restTarget, setRestTarget] = useState<RestConnectorItem | null>(null)

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/integrations', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok && json.ok) {
        setItems(json.data as Integration[])
      } else {
        toast.error(json.error ?? 'Gagal memuat daftar integrasi.')
      }
    } catch (e) {
      toast.error('Kesalahan jaringan saat memuat integrasi.')
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
        toast.error(json.error ?? 'Gagal memuat REST API connectors.')
      }
    } catch (e) {
      toast.error('Kesalahan jaringan saat memuat REST API connectors.')
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
        toast.error(json.error ?? 'Gagal menguji koneksi.')
      } else if (json.ok) {
        toast.success(
          `Koneksi berhasil. ${json.tablesCount ?? 0} tabel tersedia.`,
        )
        await fetchList()
      } else {
        toast.error(json.message ?? 'Koneksi gagal — periksa kredensial.')
        await fetchList()
      }
    } catch (e) {
      toast.error('Kesalahan jaringan saat menguji koneksi.')
      console.error(e)
    } finally {
      setTestingId(null)
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
            ? 'Integrasi sudah tidak ada. Daftar dimuat ulang.'
            : 'Integrasi berhasil dihapus.',
        )
        if (schemaTarget?.id === id) setSchemaTarget(null)
        if (queryTarget?.id === id) setQueryTarget(null)
        await fetchList()
      } else {
        toast.error(json.error ?? 'Gagal menghapus integrasi.')
      }
    } catch (e) {
      toast.error('Kesalahan jaringan saat menghapus.')
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
      toast.error('Nama dan Base URL wajib diisi.')
      return
    }
    setRestCreating(true)
    try {
      const authConfig =
        restAuthType === 'BEARER'
          ? { token: restToken }
          : restAuthType === 'API_KEY_HEADER'
            ? { headerName: 'X-API-Key', apiKey: restToken }
            : {}
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
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Gagal membuat connector.')
      toast.success('REST API connector dibuat.')
      setRestName('')
      setRestBaseUrl('')
      setRestToken('')
      setRestAuthType('NONE')
      await fetchRestList()
    } catch (e) {
      toast.error('Gagal membuat REST API connector', {
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
    <div className="space-y-5">
      {/* Action row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchList}
            disabled={loading}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Muat ulang
          </Button>
        </div>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus className="h-4 w-4" />
          Tambah Database
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Total Database"
          value={stats.total}
          icon={Server}
          tone="slate"
        />
        <StatCard
          label="Aktif"
          value={stats.active}
          icon={CheckCircle2}
          tone="emerald"
        />
        <StatCard
          label="Error / Nonaktif"
          value={stats.errorInactive}
          icon={XCircle}
          tone="rose"
        />
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Memuat integrasi…
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Database className="h-10 w-10 mx-auto text-muted-foreground/60 mb-3" />
            <p className="text-sm text-muted-foreground">
              Belum ada database terdaftar. Klik <strong>Tambah Database</strong>{' '}
              untuk mulai menghubungkan sumber data SQL.
            </p>
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
            />
          ))}
        </div>
      )}

      {/* REST API Connectors */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4" />
            REST API Connectors
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Daftarkan base URL sistem eksternal, lalu whitelist endpoint yang boleh dipanggil chatbot.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
            <Input
              value={restName}
              onChange={(e) => setRestName(e.target.value)}
              placeholder="Nama connector"
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
              </SelectContent>
            </Select>
            <Button
              onClick={handleCreateRestConnector}
              disabled={restCreating || !restName.trim() || !restBaseUrl.trim()}
            >
              {restCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Tambah REST
            </Button>
          </div>

          {restAuthType !== 'NONE' && (
            <Input
              value={restToken}
              onChange={(e) => setRestToken(e.target.value)}
              placeholder={restAuthType === 'BEARER' ? 'Bearer token' : 'API key'}
              type="password"
              className="font-mono text-sm"
            />
          )}

          {restLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Memuat REST API connectors...
            </div>
          ) : restItems.length === 0 ? (
            <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
              Belum ada REST API connector.
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
                    <Badge variant={connector.isActive ? 'default' : 'secondary'}>
                      {connector.isActive ? 'Aktif' : 'Nonaktif'}
                    </Badge>
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
                    Kelola Endpoint
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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
            <AlertDialogTitle>Hapus integrasi ini?</AlertDialogTitle>
            <AlertDialogDescription>
              Integrasi <strong>{deleteTarget?.name}</strong> akan dihapus
              permanen bersama skema yang sudah direfleksikan. Tindakan ini
              tidak dapat dibatalkan dan dicatat di audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && handleDelete(deleteTarget.id)}
              disabled={!!deletingId}
              className="bg-rose-600 hover:bg-rose-700 text-white"
            >
              {deletingId ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Menghapus...
                </>
              ) : (
                'Hapus'
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
  tone,
}: {
  label: string
  value: number
  icon: typeof Server
  tone: 'slate' | 'emerald' | 'rose'
}) {
  const toneCls = {
    slate: 'text-slate-600 bg-slate-100 dark:bg-slate-800/60 dark:text-slate-300',
    emerald:
      'text-emerald-600 bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300',
    rose: 'text-rose-600 bg-rose-100 dark:bg-rose-900/40 dark:text-rose-300',
  }[tone]
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={cn('h-10 w-10 rounded-lg flex items-center justify-center', toneCls)}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-semibold leading-tight">{value}</div>
          <div className="text-xs text-muted-foreground truncate">{label}</div>
        </div>
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
}: {
  integration: Integration
  onTest: () => void
  testing: boolean
  deleting?: boolean
  onSchema: () => void
  onQuery: () => void
  onDelete: () => void
}) {
  const [configOpen, setConfigOpen] = useState(false)
  const [config, setConfig] = useState<MaskedConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(false)

  const fetchConfig = async () => {
    if (config) return
    setConfigLoading(true)
    try {
      const res = await fetch(`/api/integrations/${integration.id}`, {
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok && json.ok) {
        setConfig(json.data.config as MaskedConfig)
      } else {
        toast.error(json.error ?? 'Gagal memuat konfigurasi.')
      }
    } catch {
      toast.error('Kesalahan jaringan saat memuat konfigurasi.')
    } finally {
      setConfigLoading(false)
    }
  }

  const isDb = integration.type === 'DATABASE'
  const Icon = isDb ? Database : Globe
  const status = STATUS_BADGE[integration.status]
  const lastOk = integration.lastTestOk

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base truncate">{integration.name}</CardTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="text-[10px]">
                {integration.provider}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {integration.type}
              </Badge>
              <Badge variant="outline" className={cn('text-[10px]', status.className)}>
                {status.label}
              </Badge>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-3">
        {/* meta row */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>Terakhir diuji:</span>
          </div>
          <div className="flex items-center gap-1.5 justify-end">
            {lastOk === true && (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            )}
            {lastOk === false && (
              <XCircle className="h-3.5 w-3.5 text-rose-500" />
            )}
            <span className="text-muted-foreground truncate">
              {timeAgo(integration.lastTestedAt)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Table2 className="h-3.5 w-3.5" />
            <span>Tabel terindeks:</span>
          </div>
          <div className="text-right font-medium">
            {integration.tableCount ?? 0} tabel
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
            <span className="font-medium">Konfigurasi (terenkripsi)</span>
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
                Memuat…
              </div>
            ) : config ? (
              <dl className="grid grid-cols-3 gap-y-1 gap-x-2">
                <ConfigRow k="host" v={String(config.host ?? '-')} />
                <ConfigRow k="port" v={String(config.port ?? '-')} />
                <ConfigRow
                  k="database"
                  v={String(config.database_name ?? '-')}
                />
                <ConfigRow k="username" v={String(config.username ?? '-')} />
                <ConfigRow
                  k="password"
                  v={String(config.password ?? '-')}
                  span={2}
                />
              </dl>
            ) : (
              <div className="text-muted-foreground">Belum dimuat.</div>
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
            Uji Koneksi
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onSchema}
            className="text-xs"
          >
            <Eye className="h-3.5 w-3.5" />
            Skema
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onQuery}
            className="text-xs"
          >
            <Terminal className="h-3.5 w-3.5" />
            Kueri
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {deleting ? 'Menghapus' : 'Hapus'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ConfigRow({
  k,
  v,
  span,
}: {
  k: string
  v: string
  span?: number
}) {
  return (
    <>
      <dt className="text-muted-foreground col-span-1">{k}</dt>
      <dd
        className={cn(
          'font-mono text-[11px] truncate',
          span === 2 ? 'col-span-2' : 'col-span-1',
        )}
        title={v}
      >
        {v}
      </dd>
    </>
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

  const isDemo = form.provider === 'SQLITE_DEMO'

  const update = (k: keyof CreateFormState, v: string) =>
    setForm((f) => ({ ...f, [k]: v }))

  const validate = (): boolean => {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = 'Nama wajib diisi.'
    if (!form.provider) e.provider = 'Provider wajib dipilih.'
    // For non-DEMO providers, require host + database_name.
    if (!isDemo) {
      if (!form.host.trim()) e.host = 'Host wajib diisi.'
      if (!form.database_name.trim()) e.database_name = 'Database wajib diisi.'
      if (!form.username.trim()) e.username = 'Username wajib diisi.'
      if (!form.password) e.password = 'Password wajib diisi.'
    }
    if (form.port && !/^\d+$/.test(form.port)) e.port = 'Port harus angka.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return
    setSubmitting(true)
    try {
      const config: Record<string, unknown> = isDemo
        ? {
            // The sample provider ignores these but the backend expects an object.
            host: 'demo',
            port: 0,
            database_name: 'demo_erp',
            username: 'demo',
            password: 'demo',
          }
        : {
            host: form.host.trim(),
            port: Number(form.port) || 0,
            username: form.username.trim(),
            password: form.password,
            database_name: form.database_name.trim(),
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
        toast.success('Integrasi berhasil dibuat & skema diindeks.')
        setForm(EMPTY_FORM)
        setErrors({})
        onCreated()
      } else {
        toast.error(json.error ?? 'Gagal membuat integrasi.')
      }
    } catch (e) {
      toast.error('Kesalahan jaringan saat membuat integrasi.')
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
          <DialogTitle>Tambah Database</DialogTitle>
          <DialogDescription>
            Daftarkan koneksi database SQL. Sistem akan mengenkripsi kredensial,
            menguji koneksi, dan merefleksikan skema secara otomatis.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="int-name">
              Nama Integrasi <span className="text-rose-500">*</span>
            </Label>
            <Input
              id="int-name"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="contoh: ERP Production"
            />
            {errors.name && (
              <p className="text-xs text-rose-500">{errors.name}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="int-provider">Database Provider</Label>
            <Select
              value={form.provider}
              onValueChange={(v) => update('provider', v)}
            >
              <SelectTrigger id="int-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SQLITE_DEMO">SQLITE_DEMO</SelectItem>
                <SelectItem value="POSTGRESQL">POSTGRESQL</SelectItem>
                <SelectItem value="MYSQL">MYSQL</SelectItem>
                <SelectItem value="MSSQL">MSSQL</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.provider && (
            <p className="text-xs text-muted-foreground bg-muted/60 border rounded-md px-3 py-2">
              {PROVIDER_HINT[form.provider] ?? 'Provider'}
              {isDemo && (
                <span className="block mt-1 text-emerald-600 dark:text-emerald-400">
                  Gunakan SQLITE_DEMO hanya untuk validasi internal sebelum koneksi production tersedia.
                </span>
              )}
            </p>
          )}

          {/* Config fields — only shown for non-DEMO providers */}
          {!isDemo && (
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
                    <p className="text-xs text-rose-500">{errors.host}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="int-port">Port</Label>
                  <Input
                    id="int-port"
                    inputMode="numeric"
                    value={form.port}
                    onChange={(e) => update('port', e.target.value)}
                    placeholder="5432"
                  />
                  {errors.port && (
                    <p className="text-xs text-rose-500">{errors.port}</p>
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
                  <p className="text-xs text-rose-500">{errors.database_name}</p>
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
                    <p className="text-xs text-rose-500">{errors.username}</p>
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
                    <p className="text-xs text-rose-500">{errors.password}</p>
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
            Batal
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Membuat & menguji…
              </>
            ) : (
              'Buat & Uji Koneksi'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ----------------------------------------------------- schema viewer */

function SchemaViewerSheet({
  integration,
  onClose,
}: {
  integration: Integration | null
  onClose: () => void
}) {
  return (
    <Sheet open={!!integration} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-[560px] w-full flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Table2 className="h-4 w-4" />
            Skema {integration?.name ?? ''}
          </SheetTitle>
          <SheetDescription>
            Refleksi tabel &amp; kolom yang di-cache dari integrasi.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 mt-2">
          {integration && (
            <SchemaViewerContent key={integration.id} integration={integration} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SchemaViewerContent({ integration }: { integration: Integration }) {
  const [data, setData] = useState<SchemaData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/integrations/${integration.id}/schema`, { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json()
        if (cancelled) return
        if (r.ok && j.ok) setData(j.data as SchemaData)
        else setError(j.error ?? 'Gagal memuat skema.')
      })
      .catch(() => {
        if (!cancelled) setError('Kesalahan jaringan saat memuat skema.')
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [integration.id])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Memuat skema…
      </div>
    )
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Gagal</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (!data) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        Tidak ada data.
      </div>
    )
  }
  if (data.tables.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        Skema kosong. Jalankan <strong>Uji Koneksi</strong> untuk merefleksikan
        tabel.
      </div>
    )
  }
  return (
    <ScrollArea className="h-full pr-2">
      <div className="text-xs text-muted-foreground mb-2">
        {data.tableCount} tabel · provider {data.provider}
      </div>
      <Accordion type="multiple" className="w-full">
        {data.tables.map((t) => (
          <AccordionItem key={t.id} value={t.id}>
            <AccordionTrigger className="hover:no-underline">
              <div className="flex items-center gap-2 min-w-0">
                <Table2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-mono text-sm truncate">
                  {t.tableName}
                </span>
                <Badge
                  variant="secondary"
                  className="text-[10px] ml-1 shrink-0"
                >
                  {t.rowCount ?? '?'} baris
                </Badge>
                <Badge
                  variant="outline"
                  className="text-[10px] ml-1 shrink-0"
                >
                  {t.columns.length} kolom
                </Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="rounded-md border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-8 text-xs">Kolom</TableHead>
                      <TableHead className="h-8 text-xs">Tipe</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {t.columns.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell className="py-1.5 text-xs font-mono">
                          {c.name}
                        </TableCell>
                        <TableCell className="py-1.5 text-xs text-muted-foreground">
                          {c.type || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </ScrollArea>
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
            Kelola endpoint whitelist dan uji request yang boleh digunakan chatbot.
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
        setError(json.error ?? 'Gagal memuat REST connector.')
      }
    } catch (e) {
      console.error(e)
      setError('Kesalahan jaringan saat memuat REST connector.')
    } finally {
      setLoading(false)
    }
  }, [connector.id])

  useEffect(() => {
    fetchDetail()
  }, [fetchDetail])

  const handleAddEndpoint = async () => {
    const trimmedPath = path.trim()
    if (!trimmedPath) {
      toast.error('Path endpoint wajib diisi.')
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
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Gagal menambah endpoint.')
      toast.success('Endpoint whitelist ditambahkan.')
      setPath('')
      setDescription('')
      await fetchDetail()
      onChanged()
    } catch (e) {
      toast.error('Gagal menambah endpoint', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleTestEndpoint = async () => {
    const trimmedPath = testPath.trim()
    if (!trimmedPath) {
      toast.error('Path test wajib diisi.')
      return
    }

    let parsedBody: unknown
    if (testBody.trim()) {
      try {
        parsedBody = JSON.parse(testBody)
      } catch {
        toast.error('Body harus JSON valid.')
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
      if (res.ok && json.ok) toast.success('REST endpoint berhasil diuji.')
      else toast.error(json.error ?? 'REST endpoint gagal diuji.')
    } catch (e) {
      console.error(e)
      toast.error('Kesalahan jaringan saat menguji endpoint.')
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Memuat REST connector...
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Gagal</AlertTitle>
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
            <Badge variant={detail.isActive ? 'default' : 'secondary'}>
              {detail.isActive ? 'Aktif' : 'Nonaktif'}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">{detail.authType}</Badge>
            <Badge variant="outline">{detail.timeoutMs}ms timeout</Badge>
            <Badge variant="outline">{detail.endpoints.length} endpoint</Badge>
          </div>
        </div>

        <div className="rounded-lg border p-3 space-y-3">
          <div>
            <div className="text-sm font-medium">Tambah Endpoint Whitelist</div>
            <p className="text-xs text-muted-foreground">
              Hanya endpoint di daftar ini yang dapat dipanggil oleh test request dan router chatbot.
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
            placeholder="Deskripsi singkat untuk AI, contoh: mengambil daftar customer aktif"
          />
          <Button
            onClick={handleAddEndpoint}
            disabled={submitting || !path.trim()}
            size="sm"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Tambah Endpoint
          </Button>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Method</TableHead>
                <TableHead className="text-xs">Path</TableHead>
                <TableHead className="text-xs">Deskripsi</TableHead>
                <TableHead className="text-xs text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.endpoints.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                    Belum ada endpoint whitelist.
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
              Klik endpoint di tabel untuk mengisi method dan path, lalu jalankan request.
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
              placeholder='{"name":"Contoh"}'
              className="font-mono text-xs resize-none"
            />
          )}
          <Button
            onClick={handleTestEndpoint}
            disabled={testing || !testPath.trim()}
            size="sm"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Terminal className="h-4 w-4" />}
            Jalankan Test
          </Button>
          {testResult !== null && (
            <pre className="max-h-[260px] overflow-auto rounded-md border bg-muted/40 p-3 text-[11px]">
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

const SAMPLE_QUERY = 'Tampilkan 5 produk dengan harga tertinggi'

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
            Ajukan pertanyaan bahasa alami. Sistem akan mengubahnya menjadi SQL,
            memvalidasi via guardrail AST, lalu mengeksekusinya.
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
      toast.error('Pertanyaan tidak boleh kosong.')
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
          reason: json.reason ?? 'Kueri ditolak oleh guardrail keamanan.',
          generatedSql: json.generatedSql,
        })
      } else {
        setErrorMsg(
          json.error ??
            json.reason ??
            'Maaf, terjadi kesalahan saat memproses kueri.',
        )
      }
    } catch (e) {
      console.error(e)
      setErrorMsg('Kesalahan jaringan saat menjalankan kueri.')
    } finally {
      setRunning(false)
    }
  }

  const rows = result?.rows ?? []
  const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : []

  return (
        <div className="space-y-3 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="nlq">Pertanyaan (Natural Language)</Label>
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
              Pre-fill: contoh kueri. Edit sesuai kebutuhan.
            </p>
            <Button onClick={handleRun} disabled={running || !query.trim()}>
              {running ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Menjalankan…
                </>
              ) : (
                <>
                  <Terminal className="h-4 w-4" />
                  Jalankan
                </>
              )}
            </Button>
          </div>

          {/* Guardrail block */}
          {result && !result.ok && result.reason && (
            <Alert variant="destructive">
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>Kueri Ditolak oleh Guardrail</AlertTitle>
              <AlertDescription className="space-y-1">
                <p>{result.reason}</p>
                {result.generatedSql && (
                  <pre className="mt-2 text-[11px] bg-rose-950/20 dark:bg-rose-950/40 rounded-md p-2 overflow-x-auto">
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
              <AlertTitle>Terjadi Kesalahan</AlertTitle>
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          )}

          {/* Success result */}
          {result && result.ok && (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    SQL yang dihasilkan
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Badge variant="secondary" className="text-[10px]">
                      {result.rowCount ?? 0} baris
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      {result.executionMs ?? 0} ms
                    </Badge>
                  </div>
                </div>
                <pre className="text-[11px] bg-background border rounded-md p-2 overflow-x-auto">
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
                  Kueri berhasil dieksekusi tetapi tidak mengembalikan baris.
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
