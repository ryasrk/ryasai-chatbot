'use client'

/**
 * Dashboard charts — plain SVG/CSS, no chart library.
 *
 * ponytail: recharts is ~500 KB of JS to draw one 7-point area chart and a
 * handful of bars. Both fit in ~60 lines here, which is what removed the
 * dashboard's remaining Lighthouse TBT. Reach for recharts again only if these
 * grow real features (brush, zoom, multi-series, legends).
 */

import { useState } from 'react'
import { Activity, Coins } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** Round the axis top up so gridlines land on readable numbers. */
function niceMax(max: number): number {
  if (max <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  return (([1, 1.5, 2, 2.5, 3, 4, 5, 10].find((s) => max <= s * pow) ?? 10) * pow)
}

const fmtTick = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`)

function Grid() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col justify-between">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="border-t border-dashed border-border/60" />
      ))}
    </div>
  )
}

function YAxis({ max }: { max: number }) {
  return (
    <div className="flex shrink-0 flex-col justify-between text-[10px] leading-none tabular-nums text-muted-foreground">
      <span>{fmtTick(max)}</span>
      <span>{fmtTick(max / 2)}</span>
      <span>0</span>
    </div>
  )
}

function Tooltip({ x, label, value }: { x: number; label: string; value: string }) {
  return (
    <div
      className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border bg-background px-2 py-1 text-[10px] shadow-md"
      style={{ left: `${Math.min(88, Math.max(12, x))}%` }}
    >
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  )
}

function ChatActivityChart({ data }: { data: { date: string; count: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const n = data.length
  const max = niceMax(Math.max(0, ...data.map((d) => d.count)))
  const px = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50)
  const py = (v: number) => 100 - (v / max) * 100
  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${px(i)},${py(d.count)}`).join(' ')
  const band = n > 1 ? 100 / (n - 1) : 100

  return (
    <div className="flex gap-1.5">
      <YAxis max={max} />
      <div className="min-w-0 flex-1">
        <div className="relative h-[140px]">
          <Grid />
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="h-full w-full"
            role="img"
            aria-label={`Chat messages per day, last ${n} days`}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id="dashboardChatFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.24} />
                <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            {n > 0 && <path d={`${line} L${px(n - 1)},100 L${px(0)},100 Z`} fill="url(#dashboardChatFill)" />}
            <path
              d={line}
              fill="none"
              stroke="var(--chart-1)"
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {hover !== null && (
              <line
                x1={px(hover)}
                y1={0}
                x2={px(hover)}
                y2={100}
                stroke="var(--border)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {data.map((d, i) => (
              <rect
                key={d.date}
                x={Math.max(0, px(i) - band / 2)}
                y={0}
                width={band}
                height={100}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </svg>
          {hover !== null && (
            <>
              <div
                className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--chart-1)] ring-2 ring-background"
                style={{ left: `${px(hover)}%`, top: `${py(data[hover].count)}%` }}
              />
              <Tooltip x={px(hover)} label={data[hover].date} value={`${data[hover].count} messages`} />
            </>
          )}
        </div>
        <div className="mt-1 flex justify-between text-[10px] leading-none text-muted-foreground">
          {data.map((d) => (
            <span key={d.date}>{d.date}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

function TokenUsageChart({ data }: { data: { purpose: string; totalTokens: number }[] }) {
  const max = niceMax(Math.max(0, ...data.map((d) => d.totalTokens)))
  return (
    <div className="flex gap-1.5">
      <YAxis max={max} />
      <div className="min-w-0 flex-1">
        <div className="relative h-[140px]">
          <Grid />
          <div className="absolute inset-0 flex items-end gap-2">
            {data.map((d) => (
              <div key={d.purpose} className="group relative h-full min-w-0 flex-1">
                <div
                  className="absolute bottom-0 w-full rounded-t-sm bg-[var(--chart-3)] transition-opacity group-hover:opacity-80"
                  style={{ height: `${(d.totalTokens / max) * 100}%` }}
                />
                <div className="pointer-events-none absolute -top-1 left-1/2 z-10 hidden -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border bg-background px-2 py-1 text-[10px] shadow-md group-hover:block">
                  <div className="text-muted-foreground">{d.purpose}</div>
                  <div className="font-medium tabular-nums">{d.totalTokens.toLocaleString('en-US')} tokens</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-1 flex gap-2 text-[10px] leading-none text-muted-foreground">
          {data.map((d) => (
            <span key={d.purpose} className="min-w-0 flex-1 truncate text-center">
              {d.purpose}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
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
          {chatTrend.length === 0 ? (
            <div className="flex h-[140px] items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
              No chat activity yet.
            </div>
          ) : (
            <ChatActivityChart data={chatTrend} />
          )}
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
            <div className="flex h-[140px] items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
              No LLM calls in the last 24h.
            </div>
          ) : (
            <TokenUsageChart data={tokenData} />
          )}
        </CardContent>
      </Card>
    </>
  )
}
