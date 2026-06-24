'use client'

import { useEffect, useState } from 'react'
import {
  Database,
  FileText,
  MessageSquare,
  Code2,
  ShieldAlert,
  TrendingUp,
  Clock,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts'
import { formatDistanceToNow } from 'date-fns'
import { id as localeId } from 'date-fns/locale'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { cn } from '@/lib/utils'
import type { AnalyticsData } from '@/lib/types'

const id = (n: number) => n.toLocaleString('id-ID')

const SEVERITY_COLORS: Record<'info' | 'warning' | 'critical', string> = {
  info: 'var(--chart-2)',
  warning: 'var(--chart-4)',
  critical: 'var(--destructive)',
}

const chatChartConfig: ChartConfig = {
  count: { label: 'Pesan Chat', color: 'var(--chart-1)' },
}
const queryChartConfig: ChartConfig = {
  count: { label: 'Kueri', color: 'var(--chart-3)' },
}
const auditChartConfig: ChartConfig = {
  info: { label: 'Info', color: 'var(--chart-2)' },
  warning: { label: 'Warning', color: 'var(--chart-4)' },
  critical: { label: 'Critical', color: 'var(--destructive)' },
}

export function DashboardView() {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/analytics', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Gagal memuat data analitik.')
        return r.json()
      })
      .then((d: AnalyticsData) => {
        if (!cancelled) setData(d)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Kesalahan tidak dikenal.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return <DashboardSkeleton />
  if (error || !data) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-10 text-center">
          <p className="text-sm text-destructive">{error ?? 'Data tidak tersedia.'}</p>
        </CardContent>
      </Card>
    )
  }

  const stats: {
    label: string
    value: number
    sub: string
    icon: typeof Database
    iconClass: string
  }[] = [
    {
      label: 'Integrasi Data',
      value: data.totals.integrations,
      sub: 'Sumber data terhubung',
      icon: Database,
      iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    },
    {
      label: 'Dokumen Knowledge Base',
      value: data.totals.documents,
      sub: 'Dokumen RAG',
      icon: FileText,
      iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    },
    {
      label: 'Sesi Chat',
      value: data.totals.chatSessions,
      sub: 'Sesi percakapan',
      icon: MessageSquare,
      iconClass: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
    },
    {
      label: 'Kueri Dieksekusi',
      value: data.totals.queriesExecuted,
      sub: `${data.querySuccessRate}% berhasil`,
      icon: Code2,
      iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
    },
    {
      label: 'Blok Guardrails',
      value: data.totals.guardrailBlocks,
      sub: 'Kueri destruktif ditolak',
      icon: ShieldAlert,
      iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
    },
  ]

  const auditPieData = [
    { name: 'info', value: data.auditBySeverity.info, key: 'info' },
    { name: 'warning', value: data.auditBySeverity.warning, key: 'warning' },
    { name: 'critical', value: data.auditBySeverity.critical, key: 'critical' },
  ].filter((d) => d.value > 0)

  const chatTrend = data.chatTrend.map((d) => ({
    date: d.date.slice(5), // MM-DD for compactness
    count: d.count,
  }))
  const queryTrend = data.queryTrend.map((d) => ({
    date: d.date.slice(5),
    count: d.count,
  }))

  return (
    <div className="space-y-4 md:space-y-6">
      {/* ---- Stat cards ---- */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 md:gap-4">
        {stats.map((s) => {
          const Icon = s.icon
          return (
            <Card key={s.label} className="py-4 gap-2">
              <CardContent className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground truncate">{s.label}</div>
                  <div className="text-2xl md:text-3xl font-semibold tracking-tight mt-1">
                    {id(s.value)}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1 truncate">{s.sub}</div>
                </div>
                <div className={cn('rounded-lg p-2 shrink-0', s.iconClass)}>
                  <Icon className="h-5 w-5" />
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* ---- Charts row ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-chart-1" />
              Aktivitas Chat (7 hari)
            </CardTitle>
            <CardDescription>Jumlah pesan chat per hari</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={chatChartConfig} className="h-[180px] w-full aspect-auto">
              <AreaChart data={chatTrend} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="chatFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={11} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} width={24} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  fill="url(#chatFill)"
                />
              </AreaChart>
            </ChartContainer>

            <div className="mt-4 border-t pt-4">
              <div className="text-xs text-muted-foreground mb-2">
                Tren Kueri SQL (7 hari)
              </div>
              <ChartContainer config={queryChartConfig} className="h-[110px] w-full aspect-auto">
                <BarChart data={queryTrend} margin={{ left: 4, right: 8, top: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} width={24} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Distribusi Audit Log</CardTitle>
            <CardDescription>Per tingkat severity</CardDescription>
          </CardHeader>
          <CardContent>
            {auditPieData.length === 0 ? (
              <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
                Belum ada audit log.
              </div>
            ) : (
              <ChartContainer config={auditChartConfig} className="h-[220px] w-full aspect-square">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                  <Pie
                    data={auditPieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {auditPieData.map((entry) => (
                      <Cell key={entry.name} fill={SEVERITY_COLORS[entry.name as keyof typeof SEVERITY_COLORS]} />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="name" />} />
                </PieChart>
              </ChartContainer>
            )}
            <div className="grid grid-cols-3 gap-2 mt-3 text-center">
              {(['info', 'warning', 'critical'] as const).map((sev) => (
                <div key={sev} className="rounded-md border bg-muted/40 p-2">
                  <div
                    className="text-lg font-semibold"
                    style={{ color: SEVERITY_COLORS[sev] }}
                  >
                    {id(data.auditBySeverity[sev])}
                  </div>
                  <div className="text-[10px] uppercase text-muted-foreground">{sev}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---- Recent queries + side lists ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Kueri Terbaru</CardTitle>
            <CardDescription>5 kueri Text-to-SQL terakhir</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-80 overflow-y-auto -mx-2 px-2 space-y-2
                            [scrollbar-width:thin] [scrollbar-color:var(--muted-foreground)_transparent]
                            [&::-webkit-scrollbar]:w-1.5
                            [&::-webkit-scrollbar-thumb]:rounded-full
                            [&::-webkit-scrollbar-thumb]:bg-muted-foreground/40">
              {data.recentQueries.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Belum ada kueri.
                </div>
              ) : (
                data.recentQueries.map((q) => (
                  <div
                    key={q.id}
                    className="rounded-lg border p-3 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{q.naturalQuery}</div>
                        <code className="block mt-1.5 text-[11px] font-mono bg-muted/60 px-2 py-1 rounded truncate max-w-full">
                          {q.generatedSql}
                        </code>
                      </div>
                      {q.success ? (
                        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 shrink-0">
                          <CheckCircle2 className="h-3 w-3" /> sukses
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="shrink-0">
                          <XCircle className="h-3 w-3" /> gagal
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">{q.integration.name}</span>
                      <span className="inline-flex items-center gap-1">
                        <Database className="h-3 w-3" />
                        {q.rowCount ?? 0} baris
                      </span>
                      <span>{q.executionMs ?? 0} ms</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatDistanceToNow(new Date(q.createdAt), { addSuffix: true, locale: localeId })}
                      </span>
                      <span>oleh {q.user.name}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4 md:space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Integrasi per Provider</CardTitle>
            </CardHeader>
            <CardContent>
              {data.integrationsByProvider.length === 0 ? (
                <div className="text-sm text-muted-foreground py-2">Belum ada integrasi.</div>
              ) : (
                <ul className="space-y-2">
                  {data.integrationsByProvider.map((p) => (
                    <li key={p.provider} className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{p.provider}</span>
                      <Badge variant="secondary">{id(p.count)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Dokumen per Kategori</CardTitle>
            </CardHeader>
            <CardContent>
              {data.documentsByCategory.length === 0 ? (
                <div className="text-sm text-muted-foreground py-2">Belum ada dokumen.</div>
              ) : (
                <ul className="space-y-2">
                  {data.documentsByCategory.map((c) => (
                    <li key={c.category} className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{c.category}</span>
                      <Badge variant="secondary">{id(c.count)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4 md:space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 md:gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="py-4">
            <CardContent className="flex items-start justify-between gap-2">
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-14" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-9 w-9 rounded-lg" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[180px] w-full" />
            <Skeleton className="mt-4 h-[110px] w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-40" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[220px] w-full rounded-full" />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </CardHeader>
          <CardContent className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </CardContent>
        </Card>
        <div className="space-y-4 md:space-y-6">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-32" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
