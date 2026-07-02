'use client'

import { useEffect, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  Clock,
  Code2,
  Database,
  FileText,
  MessageSquare,
  ShieldAlert,
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

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { AnalyticsData } from '@/lib/types'

const formatNumber = (n: number) => n.toLocaleString('id-ID')

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
      .then(async (response) => {
        if (!response.ok) throw new Error('Gagal memuat data analitik.')
        return response.json()
      })
      .then((payload: AnalyticsData) => {
        if (!cancelled) setData(payload)
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

  const stats = [
    {
      label: 'Integrasi Data',
      value: data.totals.integrations,
      sub: 'Sumber aktif',
      icon: Database,
      tone: 'emerald',
    },
    {
      label: 'Knowledge Base',
      value: data.totals.documents,
      sub: 'Dokumen siap RAG',
      icon: FileText,
      tone: 'amber',
    },
    {
      label: 'Sesi Chat',
      value: data.totals.chatSessions,
      sub: 'Percakapan tersimpan',
      icon: MessageSquare,
      tone: 'slate',
    },
    {
      label: 'Kueri SQL',
      value: data.totals.queriesExecuted,
      sub: `${data.querySuccessRate}% berhasil`,
      icon: Code2,
      tone: 'teal',
    },
    {
      label: 'Guardrail Block',
      value: data.totals.guardrailBlocks,
      sub: 'Request ditolak',
      icon: ShieldAlert,
      tone: 'rose',
    },
  ] as const

  const auditPieData = [
    { name: 'info', value: data.auditBySeverity.info },
    { name: 'warning', value: data.auditBySeverity.warning },
    { name: 'critical', value: data.auditBySeverity.critical },
  ].filter((item) => item.value > 0)

  const chatTrend = data.chatTrend.map((item) => ({
    date: item.date.slice(5),
    count: item.count,
  }))

  const queryTrend = data.queryTrend.map((item) => ({
    date: item.date.slice(5),
    count: item.count,
  }))

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
        {stats.map((stat) => (
          <MetricCard key={stat.label} {...stat} />
        ))}
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-muted-foreground" />
              Aktivitas Operasional
            </CardTitle>
            <CardDescription>Chat dan kueri selama 7 hari terakhir</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ChartContainer config={chatChartConfig} className="h-[190px] w-full aspect-auto">
              <AreaChart data={chatTrend} margin={{ left: 2, right: 8, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="dashboardChatFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.24} />
                    <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={11} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} width={26} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  fill="url(#dashboardChatFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ChartContainer>

            <div className="border-t pt-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Tren Kueri SQL</div>
              <ChartContainer config={queryChartConfig} className="h-[110px] w-full aspect-auto">
                <BarChart data={queryTrend} margin={{ left: 2, right: 8, top: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} width={26} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--chart-3)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ChartContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Audit Log</CardTitle>
            <CardDescription>Distribusi severity</CardDescription>
          </CardHeader>
          <CardContent>
            {auditPieData.length === 0 ? (
              <div className="h-[220px] flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                Belum ada audit log.
              </div>
            ) : (
              <ChartContainer config={auditChartConfig} className="h-[220px] w-full aspect-square">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                  <Pie data={auditPieData} dataKey="value" nameKey="name" innerRadius={54} outerRadius={78} paddingAngle={2}>
                    {auditPieData.map((entry) => (
                      <Cell key={entry.name} fill={SEVERITY_COLORS[entry.name as keyof typeof SEVERITY_COLORS]} />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="name" />} />
                </PieChart>
              </ChartContainer>
            )}
            <div className="grid grid-cols-3 gap-2 mt-3 text-center">
              {(['info', 'warning', 'critical'] as const).map((severity) => (
                <div key={severity} className="rounded-md border bg-muted/30 px-2 py-2">
                  <div className="text-base font-semibold" style={{ color: SEVERITY_COLORS[severity] }}>
                    {formatNumber(data.auditBySeverity[severity])}
                  </div>
                  <div className="text-[10px] uppercase text-muted-foreground">{severity}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Kueri Terbaru</CardTitle>
            <CardDescription>5 kueri Text-to-SQL terakhir</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recentQueries.length === 0 ? (
              <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
                Belum ada kueri.
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <div className="grid grid-cols-[minmax(0,1fr)_88px_108px] gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                  <div>Pertanyaan dan SQL</div>
                  <div className="text-right">Status</div>
                  <div className="text-right">Waktu</div>
                </div>
                <div className="divide-y">
                  {data.recentQueries.map((query) => (
                    <div key={query.id} className="grid grid-cols-[minmax(0,1fr)_88px_108px] gap-3 px-3 py-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{query.naturalQuery}</div>
                        <code className="mt-1 block truncate rounded bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
                          {query.generatedSql}
                        </code>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span className="font-medium text-foreground">{query.integration.name}</span>
                          <span>{query.rowCount ?? 0} baris</span>
                          <span>{query.executionMs ?? 0} ms</span>
                          <span>oleh {query.user.name}</span>
                        </div>
                      </div>
                      <div className="flex justify-end">
                        {query.success ? (
                          <Badge variant="outline" className="h-6 border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
                            <CheckCircle2 className="h-3 w-3" />
                            Sukses
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="h-6">
                            <XCircle className="h-3 w-3" />
                            Gagal
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-start justify-end gap-1 text-right text-[11px] text-muted-foreground">
                        <Clock className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          {formatDistanceToNow(new Date(query.createdAt), { addSuffix: true, locale: localeId })}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <SummaryList
            title="Integrasi per Provider"
            empty="Belum ada integrasi."
            items={data.integrationsByProvider.map((item) => ({
              label: item.provider,
              value: item.count,
            }))}
          />
          <SummaryList
            title="Dokumen per Kategori"
            empty="Belum ada dokumen."
            items={data.documentsByCategory.map((item) => ({
              label: item.category,
              value: item.count,
            }))}
          />
        </div>
      </section>
    </div>
  )
}

function MetricCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
}: {
  label: string
  value: number
  sub: string
  icon: typeof Database
  tone: 'emerald' | 'amber' | 'slate' | 'teal' | 'rose'
}) {
  const toneClass = {
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    teal: 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300',
    rose: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  }[tone]

  return (
    <Card className="min-h-[118px]">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{formatNumber(value)}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{sub}</div>
          </div>
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md', toneClass)}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function SummaryList({
  title,
  empty,
  items,
}: {
  title: string
  empty: string
  items: Array<{ label: string; value: number }>
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
            {empty}
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((item) => (
              <li key={item.label} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="truncate text-sm font-medium">{item.label}</span>
                <Badge variant="secondary">{formatNumber(item.value)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, index) => (
          <Card key={index} className="min-h-[118px]">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-8 w-16" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <Skeleton className="h-9 w-9 rounded-md" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2">
          <CardHeader>
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-56" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-[190px] w-full" />
            <Skeleton className="h-[110px] w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-40" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[220px] w-full" />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2">
          <CardHeader>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </CardHeader>
          <CardContent className="space-y-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </CardContent>
        </Card>
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, index) => (
            <Card key={index}>
              <CardHeader>
                <Skeleton className="h-4 w-36" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
