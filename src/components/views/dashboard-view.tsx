'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  Code2,
  Database,
  FileText,
  MessageSquare,
  ShieldAlert,
  Brain,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadingState, ErrorState } from '@/components/ui/view-states'
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

const formatNumber = (n: number) => n.toLocaleString('en-US')

const SEVERITY_COLORS: Record<'info' | 'warning' | 'critical', string> = {
  info: 'var(--chart-2)',
  warning: 'var(--chart-4)',
  critical: 'var(--destructive)',
}

const chatChartConfig: ChartConfig = {
  count: { label: 'Chat Messages', color: 'var(--chart-1)' },
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

  const fetchAll = useCallback(() => {
    fetch('/api/analytics', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load analytics data.')
        return response.json()
      })
      .then((payload: AnalyticsData) => setData(payload))
      .catch((e) => setError(e instanceof Error ? e.message : 'Unknown error.'))
      .finally(() => setLoading(false))
  }, [])

  const handleRefresh = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchAll()
  }, [fetchAll])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { action?: string } | undefined
      if (detail?.action === 'refresh') handleRefresh()
    }
    window.addEventListener('view-action', handler)
    return () => window.removeEventListener('view-action', handler)
  }, [handleRefresh])

  if (loading) {
    return <LoadingState />
  }
  if (error || !data) {
    return <ErrorState message={error ?? 'Data unavailable.'} onRetry={handleRefresh} />
  }

  const stats = [
    {
      label: 'Data Integrations',
      value: data.totals.integrations,
      sub: 'Active sources',
      icon: Database,
      iconClass: 'text-success',
    },
    {
      label: 'Knowledge Base',
      value: data.totals.documents,
      sub: 'RAG-ready documents',
      icon: FileText,
      iconClass: 'text-warning',
    },
    {
      label: 'Chat Sessions',
      value: data.totals.chatSessions,
      sub: 'Saved conversations',
      icon: MessageSquare,
      iconClass: 'text-muted-foreground',
    },
    {
      label: 'SQL Queries',
      value: data.totals.queriesExecuted,
      sub: `${data.querySuccessRate}% success`,
      icon: Code2,
      iconClass: 'text-success',
    },
    {
      label: 'Guardrail Block',
      value: data.totals.guardrailBlocks,
      sub: 'Rejected requests',
      icon: ShieldAlert,
      iconClass: 'text-destructive',
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
    <div className="space-y-3">
      <section className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2.5">
        {stats.map((stat) => (
          <MetricCard key={stat.label} {...stat} />
        ))}
      </section>

      <CogneeStatusBar />

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        {/* Aktivitas + SQL overview merged */}
        <Card className="xl:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="h-3.5 w-3.5 text-muted-foreground" />
              Operational Activity
            </CardTitle>
            <CardDescription className="text-xs">Chat and queries for the last 7 days</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <ChartContainer config={chatChartConfig} className="h-[140px] w-full aspect-auto">
              <AreaChart data={chatTrend} margin={{ left: 2, right: 8, top: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="dashboardChatFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.24} />
                    <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={10} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={10} width={22} />
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

            {/* SQL overview — inline stats, not a list */}
            <div className="border-t pt-2.5 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-md border bg-muted/20 px-2 py-1.5">
                <div className="text-xs text-muted-foreground">SQL queries (7 days)</div>
                <div className="text-sm font-semibold tabular-nums">{queryTrend.reduce((s, d) => s + d.count, 0)}</div>
              </div>
              <div className="rounded-md border bg-muted/20 px-2 py-1.5">
                <div className="text-xs text-muted-foreground">Total Queries</div>
                <div className="text-sm font-semibold tabular-nums">{data.recentQueries.length}</div>
              </div>
              <div className="rounded-md border bg-muted/20 px-2 py-1.5">
                <div className="text-xs text-muted-foreground">Success</div>
                <div className="text-sm font-semibold tabular-nums text-success">
                  {data.recentQueries.filter((q) => q.success).length}
                </div>
              </div>
              <div className="rounded-md border bg-muted/20 px-2 py-1.5">
                <div className="text-xs text-muted-foreground">Failed</div>
                <div className="text-sm font-semibold tabular-nums text-destructive">
                  {data.recentQueries.filter((q) => !q.success).length}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Audit Log</CardTitle>
            <CardDescription className="text-xs">Severity distribution</CardDescription>
          </CardHeader>
          <CardContent>
            {auditPieData.length === 0 ? (
              <div className="h-[140px] flex items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
                No audit logs yet.
              </div>
            ) : (
              <ChartContainer config={auditChartConfig} className="h-[140px] w-full aspect-square">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                  <Pie data={auditPieData} dataKey="value" nameKey="name" innerRadius={38} outerRadius={56} paddingAngle={2}>
                    {auditPieData.map((entry) => (
                      <Cell key={entry.name} fill={SEVERITY_COLORS[entry.name as keyof typeof SEVERITY_COLORS]} />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="name" />} />
                </PieChart>
              </ChartContainer>
            )}
            <div className="grid grid-cols-3 gap-1.5 mt-2 text-center">
              {(['info', 'warning', 'critical'] as const).map((severity) => (
                <div key={severity} className="rounded-md border bg-muted/30 px-1.5 py-1.5">
                  <div className="text-sm font-semibold" style={{ color: SEVERITY_COLORS[severity] }}>
                    {formatNumber(data.auditBySeverity[severity])}
                  </div>
                  <div className="text-xs uppercase text-muted-foreground">
                    {severity === 'info' ? 'Info' : severity === 'warning' ? 'Warning' : 'Critical'}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <SummaryList
          title="Data Sources"
          empty="No integrations yet. Add them from the Data Sources menu."
          items={data.integrationsByProvider.map((item) => ({
            label: item.provider,
            value: item.count,
          }))}
        />
        <SummaryList
          title="Knowledge"
          empty="No documents yet. Upload them from the Knowledge menu."
          items={data.documentsByCategory.map((item) => ({
            label: item.category,
            value: item.count,
          }))}
        />
      </section>
    </div>
  )
}

function MetricCard({
  label,
  value,
  sub: _sub,
  icon: Icon,
  iconClass,
}: {
  label: string
  value: number
  sub: string
  icon: typeof Database
  iconClass: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-lg font-semibold tabular-nums leading-tight">{formatNumber(value)}</div>
          <div className="truncate text-xs text-muted-foreground">{label}</div>
        </div>
        <Icon className={cn('h-4 w-4 shrink-0', iconClass)} />
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
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="rounded-md border border-dashed py-4 text-center text-xs text-muted-foreground">
            {empty}
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((item) => (
              <li key={item.label} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="truncate text-xs font-medium">{item.label}</span>
                <Badge variant="secondary" className="text-xs">{formatNumber(item.value)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function CogneeStatusBar() {
  const [cognee, setCognee] = useState<{
    enabled: boolean
    connected: boolean
    mode: string
    documents?: { total: number; cognified: number; pending: number; failed: number }
    batchSize?: number
  } | null>(null)

  useEffect(() => {
    fetch('/api/cognee')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setCognee(d.data) })
      .catch(() => {})
  }, [])

  if (!cognee) return null

  if (!cognee.enabled) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-2 px-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Brain className="h-3.5 w-3.5" />
          <span>AI Memory (Cognee)</span>
          <Badge variant="outline" className="text-[10px]">Disabled</Badge>
          <span className="text-[10px]">— enable in Settings for cross-session memory & knowledge graph</span>
        </CardContent>
      </Card>
    )
  }

  const docs = cognee.documents
  return (
    <Card>
      <CardContent className="py-2 px-3 flex items-center gap-3 text-xs flex-wrap">
        <div className="flex items-center gap-1.5">
          <Brain className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium">AI Memory</span>
        </div>
        <Badge variant={cognee.connected ? 'default' : 'destructive'} className="text-[10px]">
          {cognee.connected ? 'Connected' : 'Disconnected'}
        </Badge>
        <Badge variant="outline" className="text-[10px]">{cognee.mode}</Badge>
        {docs && (
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>{docs.cognified} graphed</span>
            {docs.pending > 0 && <span className="text-amber-600">{docs.pending} pending</span>}
            {docs.failed > 0 && <span className="text-red-600">{docs.failed} failed</span>}
            <span>· batch {cognee.batchSize}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

