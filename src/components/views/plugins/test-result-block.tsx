import { Badge } from '@/components/ui/badge'
import type { TestResult } from './types'

export function TestResultBlock({ result }: { result: TestResult }) {
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 p-2.5">
      <div className="flex items-center gap-2">
        <Badge
          className={
            'text-xs ' +
            (result.ok
              ? 'bg-success/15 text-success border-success/20'
              : 'bg-destructive/15 text-destructive border-destructive/20')
          }
        >
          {result.ok ? 'SUCCESS' : 'FAILED'}
        </Badge>
        <span className="text-xs text-muted-foreground">{result.latencyMs}ms</span>
      </div>
      {result.error && <p className="text-xs text-destructive">{result.error}</p>}
      {result.output && (
        <pre className="font-mono text-xs bg-muted/40 p-2 rounded max-h-[160px] overflow-auto [scrollbar-width:thin] whitespace-pre-wrap break-all">
          {result.output}
        </pre>
      )}
    </div>
  )
}
