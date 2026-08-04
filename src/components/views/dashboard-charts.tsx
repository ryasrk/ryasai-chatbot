'use client'

/**
 * Dashboard charts — split out of dashboard-view so recharts (~500 KB) is
 * fetched after the metric cards paint instead of blocking them.
 */

import { Activity, Coins } from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from 'recharts'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'

const chatChartConfig: ChartConfig = {
  count: { label: 'Chat Messages', color: 'var(--chart-1)' },
}

const tokenChartConfig: ChartConfig = {
  totalTokens: { label: 'Tokens', color: 'var(--chart-3)' },
}

export function DashboardCharts({
  chatTrend,
  tokenData,
}: {
  chatTrend: { date: string; count: number }[]
  tokenData: { purpose: string; totalTokens: number }[]
}) {
  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            Chat Activity
          </CardTitle>
          <CardDescription className="text-xs">Messages per day, last 7 days</CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Coins className="h-3.5 w-3.5 text-muted-foreground" />
            Token Usage (24h)
          </CardTitle>
          <CardDescription className="text-xs">Tokens by LLM purpose</CardDescription>
        </CardHeader>
        <CardContent>
          {tokenData.length === 0 ? (
            <div className="h-[140px] flex items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
              No LLM calls in the last 24h.
            </div>
          ) : (
            <ChartContainer config={tokenChartConfig} className="h-[140px] w-full aspect-auto">
              <BarChart data={tokenData} margin={{ left: 2, right: 8, top: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="purpose" tickLine={false} axisLine={false} fontSize={10} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  fontSize={10}
                  width={40}
                  tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="totalTokens" fill="var(--chart-3)" isAnimationActive={false} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </>
  )
}
