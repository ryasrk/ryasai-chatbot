'use client'

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Sparkles } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { ChartData } from '@/lib/types'
import { CHART_COLORS } from './types'

export function ChartRenderer({ data }: { data: ChartData }) {
  if (!data || !Array.isArray(data.data) || data.data.length === 0) {
    return null
  }

  const rows = data.data
  const xKey = data.xKey
  const yKeys = data.yKeys ?? []

  if (yKeys.length === 0) {
    return null
  }

  return (
    <div className="mt-1 pt-3 border-t">
      <Card className="shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Query Result Data Visualization
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[140px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              {data.type === 'bar' ? (
                <BarChart
                  data={rows}
                  margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    vertical={false}
                  />
                  <XAxis
                    dataKey={xKey}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <RTooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid hsl(var(--border))',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {yKeys.map((k, i) => (
                    <Bar
                      key={k}
                      dataKey={k}
                      fill={CHART_COLORS[i % CHART_COLORS.length]}
                      radius={[4, 4, 0, 0]}
                    />
                  ))}
                </BarChart>
              ) : data.type === 'line' ? (
                <LineChart
                  data={rows}
                  margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    vertical={false}
                  />
                  <XAxis
                    dataKey={xKey}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <RTooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid hsl(var(--border))',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {yKeys.map((k, i) => (
                    <Line
                      key={k}
                      dataKey={k}
                      type="monotone"
                      stroke={CHART_COLORS[i % CHART_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                  ))}
                </LineChart>
              ) : (
                <PieChart>
                  <RTooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid hsl(var(--border))',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Pie
                    data={rows}
                    dataKey={yKeys[0]}
                    nameKey={xKey}
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={(entry: { name?: string }) => entry?.name ?? ''}
                    labelLine={false}
                  >
                    {rows.map((_, i) => (
                      <Cell
                        key={i}
                        fill={CHART_COLORS[i % CHART_COLORS.length]}
                      />
                    ))}
                  </Pie>
                </PieChart>
              )}
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
