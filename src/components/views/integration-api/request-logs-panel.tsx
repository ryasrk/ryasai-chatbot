'use client'

import { useState, useEffect } from 'react'
import { Activity } from 'lucide-react'
import { format } from 'date-fns'
import { enUS as localeId } from 'date-fns/locale'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { TableSkeleton } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { RequestLogRow } from './types'

/* --------------------------- All Request Logs --------------------------- */

export function RequestLogsPanel() {
  const [logs, setLogs] = useState<RequestLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/api-keys/logs')
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load logs')
        return r.json()
      })
      .then((data: { items: RequestLogRow[] }) => {
        if (!cancelled) {
          setLogs(data.items ?? [])
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
      setError(e instanceof Error ? e.message : 'Error.')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return showSkeleton ? <TableSkeleton rows={8} cols={5} /> : null
  }

  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center text-xs text-destructive">{error}</CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs flex items-center gap-2">
          <Activity className="h-4 w-4" />
          All Request Logs
        </CardTitle>
        <CardDescription className="text-xs">
          Latest request logs from all API keys (max 100)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {logs.length === 0 ? (
          <p className="text-xs text-muted-foreground py-8 text-center">
            No requests yet. Create an API key and integrate to start receiving requests.
          </p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[220px]">Endpoint</TableHead>
                  <TableHead className="w-[70px]">Status</TableHead>
                  <TableHead className="w-[90px]">Latency</TableHead>
                  <TableHead className="w-[160px]">Time</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="font-mono text-xs">{log.endpoint}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          log.status < 400
                            ? 'text-emerald-600'
                            : 'text-rose-600'
                        }
                      >
                        {log.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {log.latencyMs ? `${log.latencyMs}ms` : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(log.createdAt), 'dd MMM HH:mm:ss', { locale: localeId })}
                    </TableCell>
                    <TableCell className="text-xs text-rose-600 max-w-[200px] truncate">
                      {log.errorMessage || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
