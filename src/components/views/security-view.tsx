'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Info,
  ListChecks,
  ChevronLeft,
  ChevronRight,
  Loader2,
  FlaskConical,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { format, formatDistanceToNow } from 'date-fns'
import { id as localeId } from 'date-fns/locale'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { AuditLogItem } from '@/lib/types'

const id = (n: number) => n.toLocaleString('id-ID')
const AUDIT_LOG_PAGE_SIZE = 20

type SeverityFilter = 'all' | 'critical' | 'warning' | 'info'

const DESTRUCTIVE_KEYWORDS = [
  'DELETE',
  'UPDATE',
  'INSERT',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'CREATE',
]

function severityBadgeClass(sev: string): string {
  switch (sev) {
    case 'critical':
      return 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 border-rose-200 dark:border-rose-900/60'
    case 'warning':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-900/60'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300 border-slate-200 dark:border-slate-700'
  }
}

function severityIcon(sev: string) {
  if (sev === 'critical') return <ShieldAlert className="h-3 w-3" />
  if (sev === 'warning') return <AlertTriangle className="h-3 w-3" />
  return <Info className="h-3 w-3" />
}

interface AuditPage {
  items: AuditLogItem[]
  total: number
  page: number
  pageSize: number
}

interface ToolRunItem {
  id: string
  type: string
  status: string
  latencyMs: number | null
  inputSummary: string
  outputSummary: string | null
  errorMessage: string | null
  createdAt: string
}

interface ApiRequestLogItem {
  id: string
  endpoint: string
  status: number
  latencyMs: number | null
  errorMessage: string | null
  createdAt: string
}

interface RestApiErrorItem {
  id: string
  requestSummary: string
  statusCode: number | null
  latencyMs: number | null
  errorMessage: string | null
  createdAt: string
}

interface BlockedSqlItem {
  id: string
  action: string
  severity: string
  detail: string
  createdAt: string
}

interface MonitoringData {
  ok: boolean
  toolRuns: ToolRunItem[]
  failedApiRequests: ApiRequestLogItem[]
  restApiErrors: RestApiErrorItem[]
  blockedSql: BlockedSqlItem[]
  stats: {
    toolRunCount24h: number
    avgToolLatencyMs24h: number
    failedApiCount24h: number
  }
}

export function SecurityView() {
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<SeverityFilter>('all')
  const [data, setData] = useState<AuditPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AuditLogItem | null>(null)

  // ---- monitoring data (tool runs, failed requests, blocked SQL) ----
  const [monitoring, setMonitoring] = useState<MonitoringData | null>(null)
  const [monLoading, setMonLoading] = useState(true)

  const loadMonitoring = useCallback(async () => {
    setMonLoading(true)
    try {
      const res = await fetch('/api/monitoring', { cache: 'no-store' })
      if (!res.ok) throw new Error('Gagal memuat data monitoring.')
      const json = await res.json()
      if (json?.ok) setMonitoring(json)
    } catch {
      /* keep null — tabs show empty state */
    } finally {
      setMonLoading(false)
    }
  }, [])

  useEffect(() => {
    loadMonitoring()
  }, [loadMonitoring])

  const load = useCallback(async (targetPage: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/audit?page=${targetPage}&pageSize=${AUDIT_LOG_PAGE_SIZE}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error('Gagal memuat audit log.')
      const json: AuditPage = await res.json()
      setData(json)
      setPage(json.page)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kesalahan tidak dikenal.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(1)
  }, [load])

  // ---- derived counts from currently loaded page ----
  const items = data?.items ?? []
  const filtered =
    filter === 'all' ? items : items.filter((i) => i.severity === filter)

  const totalLoaded = items.length
  const criticalCount = items.filter((i) => i.severity === 'critical').length
  const guardrailCount = items.filter((i) => i.action === 'GUARDRAIL_BLOCK').length

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const canPrev = !loading && page > 1
  const canNext = !loading && page < totalPages

  const prettyDetail = (item: AuditLogItem | null) => {
    if (!item) return ''
    try {
      const parsed = JSON.parse(item.detail)
      return JSON.stringify(parsed, null, 2)
    } catch {
      return item.detail
    }
  }

  return (
    <div className="space-y-4 md:space-y-6">
      {/* ---- monitoring stat cards ---- */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
        <Card className="py-4 gap-2">
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Tool Run (24j)</div>
              <div className="text-2xl font-semibold mt-1">{id(monitoring?.stats.toolRunCount24h ?? 0)}</div>
              <div className="text-[11px] text-muted-foreground mt-1">eksekusi tool</div>
            </div>
            <div className="rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 p-2">
              <ListChecks className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="py-4 gap-2">
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Rata-rata Latency (24j)</div>
              <div className="text-2xl font-semibold mt-1">
                {id(monitoring?.stats.avgToolLatencyMs24h ?? 0)}
                <span className="text-sm font-normal text-muted-foreground"> ms</span>
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">tool run</div>
            </div>
            <div className="rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300 p-2">
              <FlaskConical className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
        <Card className="py-4 gap-2">
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">API Gagal (24j)</div>
              <div className="text-2xl font-semibold mt-1 text-rose-600 dark:text-rose-400">
                {id(monitoring?.stats.failedApiCount24h ?? 0)}
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">status &ge; 400</div>
            </div>
            <div className="rounded-lg bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 p-2">
              <ShieldAlert className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="audit" className="w-full">
        <div className="overflow-x-auto -mx-1 px-1 pb-1">
          <TabsList className="w-max">
            <TabsTrigger value="audit" className="gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              Audit Log
            </TabsTrigger>
            <TabsTrigger value="tool-runs" className="gap-1.5">
              <ListChecks className="h-3.5 w-3.5" />
              Tool Runs
            </TabsTrigger>
            <TabsTrigger value="failed-requests" className="gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Failed Requests
            </TabsTrigger>
            <TabsTrigger value="blocked-sql" className="gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" />
              Blocked SQL
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="audit" className="mt-4 space-y-4 md:space-y-6">
      {/* ---- summary cards ---- */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
        <Card className="py-4 gap-2">
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Total Audit (halaman ini)</div>
              <div className="text-2xl font-semibold mt-1">{id(totalLoaded)}</div>
              <div className="text-[11px] text-muted-foreground mt-1">
                dari {id(data?.total ?? 0)} total
              </div>
            </div>
            <div className="rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300 p-2">
              <ListChecks className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="py-4 gap-2">
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Critical</div>
              <div className="text-2xl font-semibold mt-1 text-rose-600 dark:text-rose-400">
                {id(criticalCount)}
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">perlu perhatian</div>
            </div>
            <div className="rounded-lg bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 p-2">
              <ShieldAlert className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>

        <Card className="py-4 gap-2">
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Blok Guardrails</div>
              <div className="text-2xl font-semibold mt-1 text-amber-600 dark:text-amber-400">
                {id(guardrailCount)}
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">kueri destruktif ditolak</div>
            </div>
            <div className="rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 p-2">
              <ShieldCheck className="h-5 w-5" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---- Guardrails info panel ---- */}
      <Alert className="border-emerald-300/60 bg-emerald-50/60 dark:bg-emerald-950/20 dark:border-emerald-800/60">
        <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <AlertTitle className="text-emerald-800 dark:text-emerald-300">
          SQL AST Guardrails Aktif
        </AlertTitle>
        <AlertDescription className="text-emerald-800/90 dark:text-emerald-300/80">
          Sistem menggunakan verifikasi AST (Abstract Syntax Tree) untuk memblokir kueri SQL yang
          bersifat destruktif (DELETE / UPDATE / DROP / ALTER / TRUNCATE) dan memaksa{' '}
          <code className="font-mono bg-emerald-100/70 dark:bg-emerald-900/40 px-1 rounded">LIMIT 100</code>{' '}
          sebagai safety cap. Setiap blok dicatat ke audit log dengan severity critical.
        </AlertDescription>
      </Alert>

      {/* ---- audit log table ---- */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="text-base">Audit Log</CardTitle>
              <CardDescription>
                Semua aktivitas penting pada perusahaan ini, maksimal {AUDIT_LOG_PAGE_SIZE} event per halaman
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-1">
              {(['all', 'critical', 'warning', 'info'] as SeverityFilter[]).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  variant={filter === f ? 'default' : 'outline'}
                  onClick={() => setFilter(f)}
                  className="h-7 px-2.5 text-xs capitalize"
                >
                  {f}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="py-10 text-center text-sm text-destructive">{error}</div>
          ) : loading && !data ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : (
            <>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px]">Waktu</TableHead>
                      <TableHead className="w-[160px]">Aksi</TableHead>
                      <TableHead className="w-[110px]">Severity</TableHead>
                      <TableHead className="min-w-[200px]">Detail</TableHead>
                      <TableHead className="w-[140px]">Pengguna</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                          Tidak ada audit log untuk filter ini.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filtered.map((item) => (
                        <TableRow
                          key={item.id}
                          className="cursor-pointer"
                          onClick={() => setSelected(item)}
                        >
                          <TableCell className="text-xs text-muted-foreground align-top">
                            <div>{format(new Date(item.createdAt), 'dd MMM yyyy', { locale: localeId })}</div>
                            <div>{format(new Date(item.createdAt), 'HH:mm:ss', { locale: localeId })}</div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge variant="outline" className="font-mono text-[10px]">
                              {item.action}
                            </Badge>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge
                              variant="outline"
                              className={cn('capitalize', severityBadgeClass(item.severity))}
                            >
                              {severityIcon(item.severity)}
                              {item.severity}
                            </Badge>
                          </TableCell>
                          <TableCell className="max-w-[280px] align-top">
                            <div className="text-xs line-clamp-2 text-muted-foreground">
                              {(() => {
                                try {
                                  const parsed = JSON.parse(item.detail)
                                  return JSON.stringify(parsed)
                                } catch {
                                  return item.detail
                                }
                              })()}
                            </div>
                          </TableCell>
                          <TableCell className="align-top text-xs">
                            {item.user ? (
                              <div className="min-w-0">
                                <div className="truncate font-medium text-foreground">
                                  {item.user.name}
                                </div>
                                <div className="truncate text-muted-foreground">{item.user.email}</div>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">System</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* pagination */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mt-3 text-xs text-muted-foreground">
                <div>
                  Halaman {page} dari {totalPages} · {id(data?.total ?? 0)} total event
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canPrev}
                    onClick={() => load(page - 1)}
                    className="h-7"
                  >
                    {loading && page > 1 ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ChevronLeft className="h-3.5 w-3.5" />
                    )}
                    Prev
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canNext}
                    onClick={() => load(page + 1)}
                    className="h-7"
                  >
                    Next
                    {loading && page < totalPages ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ---- guardrail tester (client-side preview) ---- */}
      <GuardrailTester />

      {/* ---- detail dialog ---- */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected && severityIcon(selected.severity)}
              <span className="font-mono text-sm">{selected?.action}</span>
              {selected && (
                <Badge
                  variant="outline"
                  className={cn('capitalize ml-1', severityBadgeClass(selected.severity))}
                >
                  {selected.severity}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {selected && format(new Date(selected.createdAt), "dd MMM yyyy 'pukul' HH:mm:ss", {
                locale: localeId,
              })}{' '}
              · {selected?.user ? selected.user.name : 'System'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Detail JSON</div>
            <pre className="bg-muted/60 rounded-md p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-[50vh]">
              <code>{prettyDetail(selected)}</code>
            </pre>
            {selected?.ipAddress && (
              <div className="text-xs text-muted-foreground">IP: {selected.ipAddress}</div>
            )}
          </div>
        </DialogContent>
      </Dialog>
        </TabsContent>

        {/* ---- Tool Runs tab ---- */}
        <TabsContent value="tool-runs" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Tool Runs</CardTitle>
              <CardDescription>50 eksekusi tool terakhir (RAG, SQL, REST API, Chat)</CardDescription>
            </CardHeader>
            <CardContent>
              {monLoading && !monitoring ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : (monitoring?.toolRuns ?? []).length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">Belum ada tool run.</div>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[140px]">Waktu</TableHead>
                        <TableHead className="w-[100px]">Tipe</TableHead>
                        <TableHead className="w-[100px]">Status</TableHead>
                        <TableHead className="w-[90px]">Latency</TableHead>
                        <TableHead className="min-w-[200px]">Ringkasan</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(monitoring?.toolRuns ?? []).map((run) => (
                        <TableRow key={run.id}>
                          <TableCell className="text-xs text-muted-foreground align-top">
                            <div>{format(new Date(run.createdAt), 'dd MMM yyyy', { locale: localeId })}</div>
                            <div>{format(new Date(run.createdAt), 'HH:mm:ss', { locale: localeId })}</div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge variant="outline" className="font-mono text-[10px]">{run.type}</Badge>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px]',
                                run.status === 'success'
                                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                  : run.status === 'blocked'
                                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                    : 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
                              )}
                            >
                              {run.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs align-top">
                            {run.latencyMs != null ? `${run.latencyMs}ms` : '-'}
                          </TableCell>
                          <TableCell className="max-w-[300px] align-top">
                            <div className="text-xs line-clamp-2 text-muted-foreground">
                              {run.errorMessage || run.outputSummary || run.inputSummary}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Failed Requests tab ---- */}
        <TabsContent value="failed-requests" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Failed Requests</CardTitle>
              <CardDescription>50 request API eksternal & REST terakhir yang gagal (status &ge; 400)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* API request logs */}
              <div>
                <div className="text-sm font-medium mb-2">API Request Logs</div>
                {monLoading && !monitoring ? (
                  <Skeleton className="h-9 w-full" />
                ) : (monitoring?.failedApiRequests ?? []).length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">Tidak ada request gagal.</div>
                ) : (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[140px]">Waktu</TableHead>
                          <TableHead className="w-[90px]">Status</TableHead>
                          <TableHead className="w-[90px]">Latency</TableHead>
                          <TableHead className="min-w-[180px]">Endpoint / Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(monitoring?.failedApiRequests ?? []).map((req) => (
                          <TableRow key={req.id}>
                            <TableCell className="text-xs text-muted-foreground align-top">
                              <div>{format(new Date(req.createdAt), 'dd MMM yyyy', { locale: localeId })}</div>
                              <div>{format(new Date(req.createdAt), 'HH:mm:ss', { locale: localeId })}</div>
                            </TableCell>
                            <TableCell className="align-top">
                              <Badge variant="outline" className="bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 text-[10px]">
                                {req.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs align-top">
                              {req.latencyMs != null ? `${req.latencyMs}ms` : '-'}
                            </TableCell>
                            <TableCell className="max-w-[300px] align-top">
                              <div className="text-xs font-mono text-muted-foreground line-clamp-1">{req.endpoint}</div>
                              {req.errorMessage && (
                                <div className="text-[11px] text-rose-600 dark:text-rose-400 line-clamp-1">{req.errorMessage}</div>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>

              {/* REST API errors */}
              <div>
                <div className="text-sm font-medium mb-2">REST API Errors</div>
                {monLoading && !monitoring ? (
                  <Skeleton className="h-9 w-full" />
                ) : (monitoring?.restApiErrors ?? []).length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">Tidak ada error REST API.</div>
                ) : (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[140px]">Waktu</TableHead>
                          <TableHead className="w-[90px]">Status</TableHead>
                          <TableHead className="w-[90px]">Latency</TableHead>
                          <TableHead className="min-w-[180px]">Request / Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(monitoring?.restApiErrors ?? []).map((req) => (
                          <TableRow key={req.id}>
                            <TableCell className="text-xs text-muted-foreground align-top">
                              <div>{format(new Date(req.createdAt), 'dd MMM yyyy', { locale: localeId })}</div>
                              <div>{format(new Date(req.createdAt), 'HH:mm:ss', { locale: localeId })}</div>
                            </TableCell>
                            <TableCell className="align-top">
                              <Badge variant="outline" className="bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 text-[10px]">
                                {req.statusCode ?? '-'}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs align-top">
                              {req.latencyMs != null ? `${req.latencyMs}ms` : '-'}
                            </TableCell>
                            <TableCell className="max-w-[300px] align-top">
                              <div className="text-xs text-muted-foreground line-clamp-1">{req.requestSummary}</div>
                              {req.errorMessage && (
                                <div className="text-[11px] text-rose-600 dark:text-rose-400 line-clamp-1">{req.errorMessage}</div>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Blocked SQL tab ---- */}
        <TabsContent value="blocked-sql" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Blocked SQL</CardTitle>
              <CardDescription>50 blok guardrail SQL terakhir (kueri destruktif ditolak)</CardDescription>
            </CardHeader>
            <CardContent>
              {monLoading && !monitoring ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : (monitoring?.blockedSql ?? []).length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">Tidak ada blok guardrail SQL.</div>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[140px]">Waktu</TableHead>
                        <TableHead className="w-[110px]">Severity</TableHead>
                        <TableHead className="min-w-[240px]">Detail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(monitoring?.blockedSql ?? []).map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="text-xs text-muted-foreground align-top">
                            <div>{format(new Date(item.createdAt), 'dd MMM yyyy', { locale: localeId })}</div>
                            <div>{format(new Date(item.createdAt), 'HH:mm:ss', { locale: localeId })}</div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge
                              variant="outline"
                              className={cn('text-[10px]', severityBadgeClass(item.severity))}
                            >
                              {severityIcon(item.severity)}
                              {item.severity}
                            </Badge>
                          </TableCell>
                          <TableCell className="max-w-[360px] align-top">
                            <div className="text-xs line-clamp-2 text-muted-foreground">
                              {(() => {
                                try {
                                  return JSON.stringify(JSON.parse(item.detail))
                                } catch {
                                  return item.detail
                                }
                              })()}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function GuardrailTester() {
  const [sql, setSql] = useState('')
  const [result, setResult] = useState<
    | null
    | {
        ok: boolean
        matched: string[]
      }
  >(null)

  const runCheck = () => {
    const upper = sql.toUpperCase()
    const matched = DESTRUCTIVE_KEYWORDS.filter((kw) => {
      // word-boundary-ish match: \bKW\b
      const re = new RegExp(`\\b${kw}\\b`)
      return re.test(upper)
    })
    setResult({ ok: matched.length === 0, matched })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4 text-chart-3" />
          Simulasi Guardrail
        </CardTitle>
        <CardDescription>
          Preview sisi-klien · cek kata kunci destruktif (bukan verifikasi AST penuh)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          placeholder="Tempel kueri SQL di sini, mis: DELETE FROM users WHERE 1=1;"
          className="font-mono text-sm min-h-24"
          rows={4}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={runCheck} disabled={!sql.trim()}>
            <ShieldCheck className="h-3.5 w-3.5" />
            Uji Guardrails
          </Button>
          <span className="text-xs text-muted-foreground">
            Kata kunci diblokir: {DESTRUCTIVE_KEYWORDS.join(' · ')}
          </span>
        </div>

        {result && (
          <div
            className={cn(
              'rounded-lg border p-3 flex items-start gap-2',
              result.ok
                ? 'bg-emerald-50/60 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800/60'
                : 'bg-rose-50/60 border-rose-200 dark:bg-rose-950/20 dark:border-rose-800/60',
            )}
          >
            {result.ok ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="h-4 w-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            )}
            <div className="text-sm">
              {result.ok ? (
                <span className="text-emerald-800 dark:text-emerald-300">
                  LULUS (PASS) — tidak ada kata kunci destruktif terdeteksi pada preview.
                </span>
              ) : (
                <div className="text-rose-800 dark:text-rose-300 space-y-1">
                  <div>DITOLAK (FAIL) — kata kunci destruktif terdeteksi:</div>
                  <div className="flex flex-wrap gap-1">
                    {result.matched.map((m) => (
                      <Badge
                        key={m}
                        variant="outline"
                        className="font-mono text-[10px] bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/40 dark:text-rose-300 dark:border-rose-800/60"
                      >
                        {m}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
