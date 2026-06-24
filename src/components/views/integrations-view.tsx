'use client'

/**
 * IntegrationsView — Dynamic Connector Factory UI (spec §3.1, §3.2, §5.1).
 *
 * Admins register new database / API connections here. The view also exposes
 * a schema viewer (cached reflection) and a Text-to-SQL query tester that
 * exercises the full pipeline: LLM generation → AST guardrail → execution.
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
  SQLITE_DEMO: 'Database ERP simulasi — demo fungsional end-to-end',
  POSTGRESQL: 'Production PostgreSQL',
  MYSQL: 'Production MySQL / MariaDB',
  MSSQL: 'Microsoft SQL Server',
  REST_API: 'REST API connector',
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
  type: 'DATABASE' | 'API'
  provider: string
  host: string
  port: string
  username: string
  password: string
  database_name: string
}

const EMPTY_FORM: CreateFormState = {
  name: '',
  type: 'DATABASE',
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
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Integration | null>(null)
  const [schemaTarget, setSchemaTarget] = useState<Integration | null>(null)
  const [queryTarget, setQueryTarget] = useState<Integration | null>(null)

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
        fetchList()
      } else {
        toast.error(json.message ?? 'Koneksi gagal — periksa kredensial.')
        fetchList()
      }
    } catch (e) {
      toast.error('Kesalahan jaringan saat menguji koneksi.')
      console.error(e)
    } finally {
      setTestingId(null)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/integrations/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (res.ok && json.ok) {
        toast.success('Integrasi berhasil dihapus.')
        fetchList()
      } else {
        toast.error(json.error ?? 'Gagal menghapus integrasi.')
      }
    } catch (e) {
      toast.error('Kesalahan jaringan saat menghapus.')
      console.error(e)
    } finally {
      setDeleteTarget(null)
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
          Tambah Integrasi
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Total Integrasi"
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
              Belum ada integrasi terdaftar. Klik <strong>Tambah Integrasi</strong>{' '}
              untuk mulai menghubungkan database atau API.
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
              onSchema={() => setSchemaTarget(it)}
              onQuery={() => setQueryTarget(it)}
              onDelete={() => setDeleteTarget(it)}
            />
          ))}
        </div>
      )}

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
              className="bg-rose-600 hover:bg-rose-700 text-white"
            >
              Hapus
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
  onSchema,
  onQuery,
  onDelete,
}: {
  integration: Integration
  onTest: () => void
  testing: boolean
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
            className="text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Hapus
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
    if (!form.type) e.type = 'Tipe wajib dipilih.'
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
            // The demo provider ignores these but the backend expects an object.
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
          type: form.type,
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
          <DialogTitle>Tambah Integrasi Baru</DialogTitle>
          <DialogDescription>
            Daftarkan koneksi database atau API. Sistem akan mengenkripsi
            kredensial (AES-256-GCM), menguji koneksi, dan merefleksikan skema
            secara otomatis.
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

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="int-type">Tipe</Label>
              <Select
                value={form.type}
                onValueChange={(v) => update('type', v)}
              >
                <SelectTrigger id="int-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DATABASE">DATABASE</SelectItem>
                  <SelectItem value="API">API</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="int-provider">Provider</Label>
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
                  <SelectItem value="REST_API">REST_API</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {form.provider && (
            <p className="text-xs text-muted-foreground bg-muted/60 border rounded-md px-3 py-2">
              {PROVIDER_HINT[form.provider] ?? 'Provider'}
              {isDemo && (
                <span className="block mt-1 text-emerald-600 dark:text-emerald-400">
                  Pilih SQLITE_DEMO untuk demo fungsional (database ERP simulasi).
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
              Pre-fill: contoh kueri demo. Edit sesuai kebutuhan.
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
