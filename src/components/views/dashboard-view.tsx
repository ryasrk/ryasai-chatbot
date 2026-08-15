'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  Brain,
  CheckCircle2,
  Clock,
  Coins,
  Database,
  Puzzle,
  ShieldAlert,
  Zap,
} from 'lucide-react'
import { format } from 'date-fns'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ErrorState, StatGridSkeleton } from '@/components/ui/view-states'
import { AnimatedNumber, Stagger, StaggerItem } from '@/components/motion'
import { DashboardCharts } from '@/components/views/dashboard-charts'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { useCachedViewData } from '@/hooks/use-cached-view-data'
import { cn } from '@/lib/utils'
import type { AnalyticsData } from '@/lib/types'

const formatNumber = (n: number) => n.toLocaleString('en-US')

interface MonitoringStats {
  toolRunCount24h: number
  avgToolLatencyMs24h: number
  failedApiCount24h: number
  llmCalls24h: number
  llmPromptTokens24h: number
  llmCompletionTokens24h: number
  llmTotalTokens24h: number
  llmUsageByPurpose: { purpose: string; calls: number; totalTokens: number }[]
}

export function DashboardView() {
  interface DashboardBundle {
    data: AnalyticsData
    monitoring: MonitoringStats | null
    activeSchedules: number
  }

  const fetchDashboard = useCallback(async (): Promise<DashboardBundle> => {
    const [a, m, s] = await Promise.all([
      fetch('/api/analytics', { cache: 'no-store' }).then(async (response) => {
        if (!response.ok) throw new Error('Failed to load analytics data.')
        return response.json() as Promise<AnalyticsData>
      }),
      // ponytail: monitoring + schedules are best-effort; analytics is the hard dependency.
      fetch('/api/monitoring', { cache: 'no-store' })
        .then(async (r) => {
          if (!r.ok) return null
          const j = await r.json()
          return (j.stats ?? null) as MonitoringStats | null
        })
        .catch(() => null),
      fetch('/api/schedules', { cache: 'no-store' })
        .then(async (r) => {
          if (!r.ok) return 0
          const j = await r.json()
          const arr: { isActive?: boolean }[] = j.schedules ?? []
          return arr.filter((s) => s.isActive).length
        })
        .catch(() => 0),
    ])
    return { data: a, monitoring: m, activeSchedules: s }
  }, [])

  // ponytail: cached across menu switches — revisiting Dashboard renders the
  // last-fetched data instantly (no skeleton) while quietly refetching.
  const { data: bundle, loading, error, refresh: handleRefresh } = useCachedViewData('dashboard', fetchDashboard)
  const showSkeleton = useDelayedLoading(loading)

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { action?: string } | undefined
      if (detail?.action === 'refresh') handleRefresh()
    }
    window.addEventListener('view-action', handler)
    return () => window.removeEventListener('view-action', handler)
  }, [handleRefresh])

  if (loading) {
    return showSkeleton ? <StatGridSkeleton /> : null
  }
  if (error || !bundle) {
    return <ErrorState message={error ?? 'Data unavailable.'} onRetry={handleRefresh} />
  }
  const { data, monitoring, activeSchedules } = bundle

  const stats: { label: string; value: number | string; icon: typeof Database; iconClass: string }[] = [
    { label: 'Queries (24h)', value: monitoring?.toolRunCount24h ?? 0, icon: Activity, iconClass: 'text-primary' },
    { label: 'Success Rate', value: `${data.querySuccessRate}%`, icon: CheckCircle2, iconClass: 'text-success' },
    { label: 'Integrations', value: data.totals.integrations, icon: Database, iconClass: 'text-success' },
    { label: 'LLM Tokens (24h)', value: monitoring?.llmTotalTokens24h ?? 0, icon: Coins, iconClass: 'text-warning' },
    { label: 'LLM Calls (24h)', value: monitoring?.llmCalls24h ?? 0, icon: Zap, iconClass: 'text-primary' },
    { label: 'Plugin Calls', value: '—', icon: Puzzle, iconClass: 'text-muted-foreground' },
    { label: 'Active Schedules', value: activeSchedules, icon: Clock, iconClass: 'text-success' },
    { label: 'Guardrail Blocks', value: data.totals.guardrailBlocks, icon: ShieldAlert, iconClass: 'text-destructive' },
  ]

  const chatTrend = data.chatTrend.map((item) => ({
    date: item.date.slice(5),
    count: item.count,
  }))

  const tokenData = (monitoring?.llmUsageByPurpose ?? []).map((p) => ({
    purpose: p.purpose,
    totalTokens: p.totalTokens,
  }))

  return (
    <div className="space-y-3">
      <Stagger className="grid grid-cols-2 xl:grid-cols-4 gap-2.5">
        {stats.map((stat) => (
          <StaggerItem key={stat.label}>
            <MetricCard {...stat} />
          </StaggerItem>
        ))}
      </Stagger>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <DashboardCharts chatTrend={chatTrend} tokenData={tokenData} />
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Recent Activity</CardTitle>
            <CardDescription className="text-xs">Latest queries</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recentQueries.length === 0 ? (
              <div className="rounded-md border border-dashed py-4 text-center text-xs text-muted-foreground">
                No queries yet.
              </div>
            ) : (
              <ul className="divide-y rounded-md border">
                {data.recentQueries.slice(0, 10).map((q) => (
                  <li key={q.id} className="px-2.5 py-1.5 flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 w-[58px]">
                      {format(new Date(q.createdAt), 'MM-dd HH:mm')}
                    </span>
                    <span className="truncate text-xs flex-1">{q.naturalQuery}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0 hidden sm:inline truncate max-w-[80px]">
                      {q.integration?.name ?? '—'}
                    </span>
                    <Badge variant={q.success ? 'default' : 'destructive'} className="text-[10px] shrink-0">
                      {q.success ? 'OK' : 'Error'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs">System Health</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <HealthRow label="Failed API (24h)" value={`${monitoring?.failedApiCount24h ?? 0}`} valueClass="text-destructive" />
              <HealthRow label="Avg Latency (24h)" value={`${monitoring?.avgToolLatencyMs24h ?? 0}ms`} />
              <HealthRow label="Prompt Tokens (24h)" value={formatNumber(monitoring?.llmPromptTokens24h ?? 0)} />
              <HealthRow label="Completion Tokens (24h)" value={formatNumber(monitoring?.llmCompletionTokens24h ?? 0)} />
            </CardContent>
          </Card>
          <CogneeStatusBar />
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              Scheduled Runs
            </CardTitle>
            <CardDescription className="text-xs">Latest automated executions</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recentScheduledRuns.length === 0 ? (
              <div className="rounded-md border border-dashed py-4 text-center text-xs text-muted-foreground">
                No scheduled runs yet.
              </div>
            ) : (
              <ul className="divide-y rounded-md border">
                {data.recentScheduledRuns.map((r, i) => {
                  const ok = (() => {
                    try {
                      const p = JSON.parse(r.lastResult ?? '') as Record<string, unknown>
                      return !('error' in p)
                    } catch {
                      return null
                    }
                  })()
                  const preview = (() => {
                    try {
                      const p = JSON.parse(r.lastResult ?? '') as Record<string, unknown>
                      if (typeof p.answer === 'string') return p.answer
                      if (typeof p.error === 'string') return p.error
                      return ''
                    } catch {
                      return r.lastResult ?? ''
                    }
                  })()
                  return (
                    <li key={i} className="px-2.5 py-1.5 flex items-start gap-2">
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 w-[58px] mt-0.5">
                        {r.lastRunAt ? format(new Date(r.lastRunAt), 'MM-dd HH:mm') : '—'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="truncate text-xs font-medium block">{r.name}</span>
                        <span className="line-clamp-2 text-[10px] text-muted-foreground">{preview}</span>
                      </div>
                      {ok !== null && (
                        <Badge variant={ok ? 'default' : 'destructive'} className="text-[10px] shrink-0">
                          {ok ? 'OK' : 'Err'}
                        </Badge>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
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
  icon: Icon,
  iconClass,
}: {
  label: string
  value: number | string
  icon: typeof Database
  iconClass: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-lg font-semibold tabular-nums leading-tight">
            {typeof value === 'number' ? <AnimatedNumber value={value} format={formatNumber} /> : value}
          </div>
          <div className="truncate text-xs text-muted-foreground">{label}</div>
        </div>
        <Icon className={cn('h-4 w-4 shrink-0', iconClass)} />
      </CardContent>
    </Card>
  )
}

function HealthRow({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/20 px-2.5 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-semibold tabular-nums', valueClass)}>{value}</span>
    </div>
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
    config?: { enabled: boolean } | null
  } | null>(null)

  useEffect(() => {
    fetch('/api/cognee')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setCognee(d.data) })
      .catch(() => {})
  }, [])

  if (!cognee) return null

  if (!cognee.enabled) {
    // DB-side "enabled" (config.enabled) can be true while the effective
    // `enabled` stays false because the server's COGNEE_ENABLED env var is
    // off — a deliberate fail-closed gate, not something Settings controls
    // alone. Say so instead of telling an admin who already enabled it to
    // "enable in Settings" again.
    const envBlocked = !!cognee.config?.enabled
    return (
      <Card className="border-dashed">
        <CardContent className="py-2 px-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Brain className="h-3.5 w-3.5" />
          <span>AI Memory (Cognee)</span>
          <Badge variant={envBlocked ? 'destructive' : 'outline'} className="text-[10px]">
            {envBlocked ? 'Blocked by server config' : 'Disabled'}
          </Badge>
          <span className="text-[10px]">
            {envBlocked
              ? '— enabled in Settings, but COGNEE_ENABLED is off on the server; ask an admin to set it'
              : '— enable in Settings for cross-session memory & knowledge graph'}
          </span>
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
            {docs.pending > 0 && <span className="text-warning">{docs.pending} pending</span>}
            {docs.failed > 0 && <span className="text-destructive">{docs.failed} failed</span>}
            <span>· batch {cognee.batchSize}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
