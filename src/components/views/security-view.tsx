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
  ChevronDown,
  Loader2,
  FlaskConical,
  Coins,
} from 'lucide-react'
import { format } from 'date-fns'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { TableSkeleton, ListRowsSkeleton } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { Button } from '@/components/ui/button'
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
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { AuditLogItem } from '@/lib/types'

const id = (n: number) => n.toLocaleString('en-US')
const AUDIT_LOG_PAGE_SIZE = 20

type SeverityFilter = 'all' | 'critical' | 'warning' | 'info'

function severityBadgeClass(sev: string): string {
  switch (sev) {
    case 'critical':
      return 'bg-destructive/15 text-destructive border-destructive/20'
    case 'warning':
      return 'bg-warning/15 text-warning border-warning/20'
    default:
      return 'bg-info/15 text-info border-info/20'
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

interface TraceItem {
  id: string
  purpose: string
  provider: string
  model: string
  inputPreview: string
  outputPreview: string
  toolCalls?: Array<{ name: string; arguments: string }>
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  latencyMs: number
  timestamp: string
  error?: string
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
    llmCalls24h: number
    llmPromptTokens24h: number
    llmCompletionTokens24h: number
    llmTotalTokens24h: number
    llmUsageByPurpose: Array<{ purpose: string; calls: number; totalTokens: number }>
  }
}

export function SecurityView() {
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<SeverityFilter>('all')
  const [data, setData] = useState<AuditPage | null>(null)
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AuditLogItem | null>(null)

  // ---- monitoring data (tool runs, failed requests, blocked SQL) ----
  const [monitoring, setMonitoring] = useState<MonitoringData | null>(null)
  const [monLoading, setMonLoading] = useState(true)
  const showMonSkeleton = useDelayedLoading(monLoading)

  // ---- recent LLM traces (in-memory observability ring buffer) ----
  const [tracesOpen, setTracesOpen] = useState(false)
  const [traces, setTraces] = useState<TraceItem[]>([])
  const [tracesLoading, setTracesLoading] = useState(false)

  const loadTraces = useCallback(async () => {
    setTracesLoading(true)
    try {
      const res = await fetch('/api/traces?limit=20', { cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      if (json?.ok) setTraces(json.traces ?? [])
    } catch {
      /* keep last */
    } finally {
      setTracesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!tracesOpen) return
    loadTraces()
    const t = setInterval(loadTraces, 10000)
    return () => clearInterval(t)
  }, [tracesOpen, loadTraces])

  const loadMonitoring = useCallback(async () => {
    setMonLoading(true)
    try {
      const res = await fetch('/api/monitoring', { cache: 'no-store' })
      if (!res.ok) throw new Error('Failed to load monitoring data.')
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
      if (!res.ok) throw new Error('Failed to load audit log.')
      const json: AuditPage = await res.json()
      setData(json)
      setPage(json.page)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error.')
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
    <div className="space-y-3">
      {/* ---- monitoring stat cards ---- */}
      <div className="grid grid-cols-3 gap-2.5">
        <Card>
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold leading-tight">{id(monitoring?.stats.toolRunCount24h ?? 0)}</div>
              <div className="text-xs text-muted-foreground">Tool Runs (24h)</div>
            </div>
            <ListChecks className="h-4 w-4 text-success shrink-0" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold leading-tight">
                {id(monitoring?.stats.avgToolLatencyMs24h ?? 0)}
                <span className="text-xs font-normal text-muted-foreground"> ms</span>
              </div>
              <div className="text-xs text-muted-foreground">Avg Latency (24h)</div>
            </div>
            <FlaskConical className="h-4 w-4 text-muted-foreground shrink-0" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold leading-tight text-destructive">
                {id(monitoring?.stats.failedApiCount24h ?? 0)}
              </div>
              <div className="text-xs text-muted-foreground">Failed API (24h)</div>
            </div>
            <ShieldAlert className="h-4 w-4 text-destructive shrink-0" />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        <Card>
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold leading-tight">
                {id(monitoring?.stats.llmTotalTokens24h ?? 0)}
              </div>
              <div className="text-xs text-muted-foreground">LLM Tokens (24h)</div>
            </div>
            <Coins className="h-4 w-4 text-muted-foreground shrink-0" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold leading-tight">
                {id(monitoring?.stats.llmCalls24h ?? 0)}
              </div>
              <div className="text-xs text-muted-foreground">LLM Calls (24h)</div>
            </div>
            <ListChecks className="h-4 w-4 text-muted-foreground shrink-0" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold leading-tight">
                {id(
                  monitoring?.stats.llmCalls24h
                    ? Math.round((monitoring?.stats.llmTotalTokens24h ?? 0) / monitoring.stats.llmCalls24h)
                    : 0,
                )}
              </div>
              <div className="text-xs text-muted-foreground">Avg Tokens/Call</div>
            </div>
            <FlaskConical className="h-4 w-4 text-muted-foreground shrink-0" />
          </CardContent>
        </Card>
      </div>

      {/* ---- recent LLM traces (observability ring buffer) ---- */}
      <Collapsible open={tracesOpen} onOpenChange={setTracesOpen}>
        <Card>
          <CardContent className="py-2.5">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs h-7 px-2 w-full justify-between">
                <span className="flex items-center gap-1.5">
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', tracesOpen && 'rotate-180')} />
                  Recent LLM Traces
                </span>
                <span className="text-[11px] text-muted-foreground">{traces.length} in buffer</span>
              </Button>
            </CollapsibleTrigger>
          </CardContent>
          <CollapsibleContent>
            <div className="px-3 pb-3">
              {tracesLoading && traces.length === 0 ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : traces.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">No traces yet. LLM calls will appear here.</div>
              ) : (
                <div className="rounded-md border overflow-y-auto [scrollbar-width:thin] max-h-[50vh]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[80px] text-xs">Time</TableHead>
                        <TableHead className="w-[90px] text-xs">Purpose</TableHead>
                        <TableHead className="w-[120px] text-xs">Model</TableHead>
                        <TableHead className="w-[70px] text-xs">Latency</TableHead>
                        <TableHead className="w-[70px] text-xs">Tokens</TableHead>
                        <TableHead className="w-[70px] text-xs">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {traces.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell className="text-xs text-muted-foreground align-top">
                            {format(new Date(t.timestamp), 'HH:mm:ss')}
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge variant="outline" className="font-mono text-xs">{t.purpose}</Badge>
                          </TableCell>
                          <TableCell className="text-xs align-top text-muted-foreground line-clamp-1 max-w-[160px]">{t.model}</TableCell>
                          <TableCell className="text-xs align-top">{t.latencyMs}ms</TableCell>
                          <TableCell className="text-xs align-top">{t.usage?.totalTokens ?? '-'}</TableCell>
                          <TableCell className="align-top">
                            {t.error ? (
                              <Badge variant="outline" className="bg-destructive/15 text-destructive text-xs">error</Badge>
                            ) : (
                              <Badge variant="outline" className="bg-success/15 text-success text-xs">ok</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Tabs defaultValue="audit" className="w-full">
        <div className="overflow-x-auto -mx-1 px-1 pb-1">
          <TabsList className="w-max">
            <TabsTrigger value="audit" className="gap-1.5 text-xs">
              <ShieldCheck className="h-3.5 w-3.5" />
              Audit Log
            </TabsTrigger>
            <TabsTrigger value="tool-runs" className="gap-1.5 text-xs">
              <ListChecks className="h-3.5 w-3.5" />
              Tool Runs
            </TabsTrigger>
            <TabsTrigger value="failed-requests" className="gap-1.5 text-xs">
              <AlertTriangle className="h-3.5 w-3.5" />
              Failed Requests
            </TabsTrigger>
            <TabsTrigger value="blocked-sql" className="gap-1.5 text-xs">
              <ShieldAlert className="h-3.5 w-3.5" />
              Blocked SQL
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="audit" className="mt-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Audit Log</span>
              <div className="flex gap-1">
                {(['all', 'critical', 'warning', 'info'] as SeverityFilter[]).map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    variant={filter === f ? 'default' : 'outline'}
                    onClick={() => setFilter(f)}
                    className="h-7 px-2.5 text-xs"
                  >
                    {f === 'all' ? 'All' : f === 'critical' ? 'Critical' : f === 'warning' ? 'Warning' : 'Info'}
                  </Button>
                ))}
              </div>
            </div>
            {error ? (
              <div className="py-10 text-center text-xs text-destructive">{error}</div>
            ) : showSkeleton && !data ? (
              <TableSkeleton rows={8} cols={4} />
            ) : filtered.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground overflow-hidden">
                No audit logs for this filter.
              </div>
            ) : (
              <>
                <div className="overflow-y-auto [scrollbar-width:thin] rounded-md border max-h-[60vh]">
                  {filtered.map((item) => (
                    <div
                      key={item.id}
                      className="font-mono text-xs flex gap-2 px-2 py-1 hover:bg-muted/30 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setSelected(item)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(item) } }}
                      tabIndex={0}
                    >
                      <span className="text-muted-foreground shrink-0">
                        [{format(new Date(item.createdAt), 'yyyy-MM-dd HH:mm:ss')}]
                      </span>
                      <span className={cn(
                        'shrink-0 w-[70px]',
                        item.severity === 'critical' ? 'text-destructive' : item.severity === 'warning' ? 'text-warning' : 'text-muted-foreground',
                      )}>
                        {item.severity.toUpperCase()}
                      </span>
                      <span className="shrink-0 w-[180px] text-foreground">
                        {item.action}
                      </span>
                      <span className="flex-1 min-w-0 text-muted-foreground line-clamp-1">
                        {(() => {
                          try {
                            return JSON.stringify(JSON.parse(item.detail))
                          } catch {
                            return item.detail
                          }
                        })()}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {item.user ? item.user.email : 'system'}
                      </span>
                    </div>
                  ))}
                </div>

                {/* pagination */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mt-3 text-xs text-muted-foreground px-1">
                  <div>
                    Page {page} of {totalPages} · {id(data?.total ?? 0)} total events
                  </div>
                  <div className="flex items-center gap-2">
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
                      Previous
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
          </div>
        </TabsContent>

        {/* ---- Tool Runs tab ---- */}
        <TabsContent value="tool-runs" className="mt-3">
          <div className="space-y-2">
            <div className="text-xs font-medium">Tool Runs — last 50 tool executions (RAG, SQL, REST API, Chat)</div>
            {showMonSkeleton && !monitoring ? (
              <ListRowsSkeleton count={5} />
            ) : (monitoring?.toolRuns ?? []).length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground overflow-hidden">No tool runs yet.</div>
            ) : (
              <div className="rounded-md border overflow-y-auto [scrollbar-width:thin] max-h-[60vh]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px] text-xs">Time</TableHead>
                      <TableHead className="w-[100px] text-xs">Type</TableHead>
                      <TableHead className="w-[100px] text-xs">Status</TableHead>
                      <TableHead className="w-[90px] text-xs">Latency</TableHead>
                      <TableHead className="min-w-[200px] text-xs">Summary</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(monitoring?.toolRuns ?? []).map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="text-xs text-muted-foreground align-top">
                          <div>{format(new Date(run.createdAt), 'dd MMM yyyy')}</div>
                          <div>{format(new Date(run.createdAt), 'HH:mm:ss')}</div>
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge variant="outline" className="font-mono text-xs">{run.type}</Badge>
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-xs',
                              run.status === 'success'
                                ? 'bg-success/15 text-success'
                                : run.status === 'blocked'
                                  ? 'bg-warning/15 text-warning'
                                  : 'bg-destructive/15 text-destructive',
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
          </div>
        </TabsContent>

        {/* ---- Failed Requests tab ---- */}
        <TabsContent value="failed-requests" className="mt-3">
          <div className="space-y-4">
            <div className="text-xs font-medium">Failed Requests — last 50 external API & REST requests that failed (status &ge; 400)</div>
            {/* API request logs */}
            <div>
              <div className="text-xs font-medium mb-2">API Request Logs</div>
              {showMonSkeleton && !monitoring ? (
                <div className="flex items-center justify-center py-4 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : (monitoring?.failedApiRequests ?? []).length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground overflow-hidden">No failed requests.</div>
              ) : (
                <div className="rounded-md border overflow-y-auto [scrollbar-width:thin] max-h-[60vh]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[140px] text-xs">Time</TableHead>
                        <TableHead className="w-[90px] text-xs">Status</TableHead>
                        <TableHead className="w-[90px] text-xs">Latency</TableHead>
                        <TableHead className="min-w-[180px] text-xs">Endpoint / Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(monitoring?.failedApiRequests ?? []).map((req) => (
                        <TableRow key={req.id}>
                          <TableCell className="text-xs text-muted-foreground align-top">
                            <div>{format(new Date(req.createdAt), 'dd MMM yyyy')}</div>
                            <div>{format(new Date(req.createdAt), 'HH:mm:ss')}</div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge variant="outline" className="bg-destructive/15 text-destructive text-xs">
                              {req.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs align-top">
                            {req.latencyMs != null ? `${req.latencyMs}ms` : '-'}
                          </TableCell>
                          <TableCell className="max-w-[300px] align-top">
                            <div className="text-xs font-mono text-muted-foreground line-clamp-1">{req.endpoint}</div>
                            {req.errorMessage && (
                              <div className="text-xs text-destructive line-clamp-1">{req.errorMessage}</div>
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
              <div className="text-xs font-medium mb-2">REST API Errors</div>
              {showMonSkeleton && !monitoring ? (
                <div className="flex items-center justify-center py-4 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : (monitoring?.restApiErrors ?? []).length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground overflow-hidden">No REST API errors.</div>
              ) : (
                <div className="rounded-md border overflow-y-auto [scrollbar-width:thin] max-h-[60vh]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[140px] text-xs">Time</TableHead>
                        <TableHead className="w-[90px] text-xs">Status</TableHead>
                        <TableHead className="w-[90px] text-xs">Latency</TableHead>
                        <TableHead className="min-w-[180px] text-xs">Request / Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(monitoring?.restApiErrors ?? []).map((req) => (
                        <TableRow key={req.id}>
                          <TableCell className="text-xs text-muted-foreground align-top">
                            <div>{format(new Date(req.createdAt), 'dd MMM yyyy')}</div>
                            <div>{format(new Date(req.createdAt), 'HH:mm:ss')}</div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge variant="outline" className="bg-destructive/15 text-destructive text-xs">
                              {req.statusCode ?? '-'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs align-top">
                            {req.latencyMs != null ? `${req.latencyMs}ms` : '-'}
                          </TableCell>
                          <TableCell className="max-w-[300px] align-top">
                            <div className="text-xs text-muted-foreground line-clamp-1">{req.requestSummary}</div>
                            {req.errorMessage && (
                              <div className="text-xs text-destructive line-clamp-1">{req.errorMessage}</div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ---- Blocked SQL tab ---- */}
        <TabsContent value="blocked-sql" className="mt-3">
          <div className="space-y-2">
            <div className="text-xs font-medium">Blocked SQL — last 50 guardrail SQL blocks (destructive queries rejected)</div>
            {showMonSkeleton && !monitoring ? (
              <ListRowsSkeleton count={5} />
            ) : (monitoring?.blockedSql ?? []).length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground overflow-hidden">No blocked SQL entries.</div>
            ) : (
              <div className="rounded-md border overflow-y-auto [scrollbar-width:thin] max-h-[60vh]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px] text-xs">Time</TableHead>
                      <TableHead className="w-[110px] text-xs">Severity</TableHead>
                      <TableHead className="min-w-[240px] text-xs">Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(monitoring?.blockedSql ?? []).map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="text-xs text-muted-foreground align-top">
                          <div>{format(new Date(item.createdAt), 'dd MMM yyyy')}</div>
                          <div>{format(new Date(item.createdAt), 'HH:mm:ss')}</div>
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge
                            variant="outline"
                            className={cn('text-xs', severityBadgeClass(item.severity))}
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
          </div>
        </TabsContent>
      </Tabs>

      {/* ---- detail dialog ---- */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected && severityIcon(selected.severity)}
              <span className="font-mono text-xs">{selected?.action}</span>
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
              {selected && format(new Date(selected.createdAt), "dd MMM yyyy 'at' HH:mm:ss")}{' '}
              · {selected?.user ? selected.user.name : 'System'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">JSON Detail</div>
            <pre className="bg-muted/60 rounded-md p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-[50vh]">
              <code>{prettyDetail(selected)}</code>
            </pre>
            {selected?.ipAddress && (
              <div className="text-xs text-muted-foreground">IP: {selected.ipAddress}</div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
