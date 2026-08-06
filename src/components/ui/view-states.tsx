'use client'
import { Loader2, AlertCircle, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { cn } from '@/lib/utils'

/**
 * Delay-gates a loading fallback so a fast load never flashes it.
 *
 * ponytail: for the places that have no `loading` boolean to hand to
 * useDelayedLoading — chiefly next/dynamic's `loading:` option, which renders
 * the instant a menu item is clicked. A warm chunk resolves in 10-50 ms, so
 * every switch painted skeleton → blank → content. Mounted means loading, so
 * the hook gets a constant true and unmounting cancels the timer.
 */
export function Delayed({ children, delay }: { children: React.ReactNode; delay?: number }) {
  return useDelayedLoading(true, delay) ? <>{children}</> : null
}

export function LoadingState({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      <span className="ml-2 text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skeleton patterns — replace spinner loading states with layout-matching
// skeletons so users see the shape of the content before it arrives.
// ponytail: each pattern matches a real view layout (stat grid, card grid,
// list rows, table, form, chat). Animate-pulse only (GPU-friendly).
// ---------------------------------------------------------------------------

/** Stat grid skeleton — for dashboard (4-col grid of metric cards + 2 charts). */
export function StatGridSkeleton({ stats = 8, charts = 2 }: { stats?: number; charts?: number }) {
  return (
    <div className="space-y-3">
      <section className="grid grid-cols-2 xl:grid-cols-4 gap-2.5">
        {Array.from({ length: stats }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-4 w-4 rounded-full" />
            </CardContent>
          </Card>
        ))}
      </section>
      <section className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {Array.from({ length: charts }).map((_, i) => (
          <Card key={i}>
            <CardHeader><Skeleton className="h-4 w-32" /></CardHeader>
            <CardContent><Skeleton className="h-[140px] w-full" /></CardContent>
          </Card>
        ))}
      </section>
    </div>
  )
}

/** Card grid skeleton — for integrations, knowledge-base (2-col card grid). */
export function CardGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardHeader><Skeleton className="h-4 w-3/4" /></CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/** List rows skeleton — for schedules, sessions, API keys, MCP servers, custom tools. */
export function ListRowsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md border p-3">
          <Skeleton className="h-8 w-8 rounded-md shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
          <Skeleton className="h-6 w-16 rounded-md shrink-0" />
        </div>
      ))}
    </div>
  )
}

/** Table skeleton — for security logs, request logs, schema viewer. */
export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 border-b last:border-0 px-3 py-2.5">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Form skeleton — for ai-config, settings, prompt-tools, rest-connector-sheet. */
export function FormSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
        <div className="flex justify-end">
          <Skeleton className="h-9 w-20" />
        </div>
      </CardContent>
    </Card>
  )
}

/** Chat message skeleton — alternating bubbles for chat loading. */
export function ChatMessageSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-4 p-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={cn('flex', i % 2 === 0 ? 'justify-end' : 'justify-start')}>
          <div className="space-y-2 max-w-[70%]">
            <Skeleton className="h-16 w-64 rounded-xl" />
            <Skeleton className="h-2 w-20" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Session list skeleton — narrow vertical list for sidebar panels. */
export function SessionListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="p-1.5 space-y-0.5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg px-2 py-1.5">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2 w-1/2 mt-1" />
        </div>
      ))}
    </div>
  )
}

/** Detail dialog skeleton — meta grid + content blocks for doc detail. */
export function DetailSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-md border bg-muted/30 px-2.5 py-1.5 space-y-1">
            <Skeleton className="h-2 w-12" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-md border bg-background p-3 space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-12 w-full" />
        </div>
      ))}
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon
  title: string
  hint?: string
  action?: React.ReactNode
}) {
  return (
    <div className="view-fade flex flex-col items-center justify-center py-12 text-center">
      <Icon className="h-8 w-8 text-muted-foreground/50 mb-3" />
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <Alert variant="destructive" className="my-4">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between">
        <span className="text-xs">{message}</span>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} className="ml-4 h-7 text-xs">
            Try Again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
