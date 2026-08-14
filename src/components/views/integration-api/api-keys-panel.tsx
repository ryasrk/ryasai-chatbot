'use client'

import { useState, useCallback, useEffect } from 'react'
import {
  KeyRound,
  Plus,
  Trash2,
  Copy,
  Loader2,
  Activity,
  Clock,
} from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { enUS as localeId } from 'date-fns/locale'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ListRowsSkeleton } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { extractError } from '@/lib/extract-error'
import { ApiKeyRow, RequestLogRow } from './types'
import { copyText } from './utils'

/* ----------------------------- API Keys Panel ----------------------------- */

export function ApiKeysPanel() {
  const [items, setItems] = useState<ApiKeyRow[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [rateLimit, setRateLimit] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null)

  const load = useCallback(async (showSkeleton = false) => {
    if (showSkeleton) setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/api-keys', { cache: 'no-store' })
      if (!res.ok) throw new Error('Failed to load API keys.')
      const data = (await res.json()) as { items: ApiKeyRow[] }
      setItems(data.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error.')
    } finally {
      if (showSkeleton) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(true)
  }, [load])

  async function handleCreate() {
    const clean = label.trim()
    if (!clean) {
      toast.error('API key name is required.')
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/settings/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: clean,
          requestLimitPerMinute: rateLimit ? Number(rateLimit) : null,
          dailyRequestLimit: dailyLimit ? Number(dailyLimit) : null,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to create API key.'))
      setNewKey(json.apiKey)
      setLabel('')
      setRateLimit('')
      setDailyLimit('')
      toast.success('API key created. Save it now, it is only shown once.')
      await load(false)
    } catch (e) {
      toast.error('Failed to create API key', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(id: string) {
    setRevokingId(id)
    setConfirmRevokeId(null)
    try {
      const res = await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) {
        const json = await res.json().catch(() => ({}))
        throw new Error(extractError(json.error, 'Failed to revoke API key.'))
      }
      toast.success('API key revoked.')
      await load(false)
    } catch (e) {
      toast.error('Failed to revoke API key', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setRevokingId(null)
    }
  }

  if (loading) {
    return showSkeleton ? <ListRowsSkeleton count={4} /> : null
  }

  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center text-xs text-destructive">{error}</CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xs flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Create New API Key
          </CardTitle>
          <CardDescription className="text-xs">
            Generate a Bearer token to integrate the chatbot with other systems
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2 sm:col-span-1">
              <Label htmlFor="key-label" className="text-xs">API Key Name</Label>
              <Input
                id="key-label"
                className="text-xs"
                placeholder="e.g. ERP Backend"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rate-limit" className="text-xs">Rate Limit (req/min)</Label>
              <Input
                id="rate-limit"
                type="number"
                min={1}
                className="text-xs"
                placeholder="empty = unlimited"
                value={rateLimit}
                onChange={(e) => setRateLimit(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="daily-limit" className="text-xs">Daily Limit (req/day)</Label>
              <Input
                id="daily-limit"
                type="number"
                min={1}
                className="text-xs"
                placeholder="empty = unlimited"
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={handleCreate} disabled={creating || !label.trim()}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Generate API Key
          </Button>

          {newKey && (
            <Alert className="border-amber-300 bg-amber-50/70 dark:bg-amber-950/20">
              <KeyRound className="h-4 w-4 text-amber-700 dark:text-amber-300" />
              <AlertTitle>Save the API key now</AlertTitle>
              <AlertDescription>
                The key is only shown once and cannot be viewed again.
                <div className="mt-2 flex items-center gap-2 rounded-md bg-background/80 border px-2 py-1.5">
                  <code className="font-mono text-xs break-all flex-1">{newKey}</code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyText(newKey, 'API key copied.')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xs flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            API Keys List
          </CardTitle>
          <CardDescription className="text-xs">Manage all active and inactive API keys</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[160px]">Name</TableHead>
                  <TableHead className="w-[140px]">Key</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead className="w-[120px]">Rate Limit</TableHead>
                  <TableHead className="w-[140px]">Last Used</TableHead>
                  <TableHead className="w-[110px]">Created</TableHead>
                  <TableHead className="w-[80px]" />
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-xs text-muted-foreground py-8">
                      No API keys yet. Create one above.
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-medium text-xs">{item.label}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{item.maskedKey}</TableCell>
                      <TableCell>
                        {item.isActive && !item.revokedAt ? (
                          <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Revoked</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.requestLimitPerMinute ?? '∞'}/min
                        <br />
                        {item.dailyRequestLimit ?? '∞'}/day
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.lastUsedAt ? format(new Date(item.lastUsedAt), 'dd MMM HH:mm', { locale: localeId }) : 'Never used'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(item.createdAt), 'dd MMM yyyy', { locale: localeId })}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelectedKeyId(selectedKeyId === item.id ? null : item.id)}
                          aria-label="View request logs"
                        >
                          <Activity className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!item.isActive || !!item.revokedAt || revokingId === item.id}
                          onClick={() => setConfirmRevokeId(item.id)}
                          className="text-destructive hover:text-destructive"
                        >
                          {revokingId === item.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {selectedKeyId && (
            <div className="mt-4">
              <RequestLogsForKey apiKeyId={selectedKeyId} />
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!confirmRevokeId} onOpenChange={(v) => !v && setConfirmRevokeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this API key?</AlertDialogTitle>
            <AlertDialogDescription>
              Revoked API keys cannot be used anymore. Integrations using this key will stop working.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!!revokingId}
              onClick={() => confirmRevokeId && handleRevoke(confirmRevokeId)}
            >
              {revokingId ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function RequestLogsForKey({ apiKeyId }: { apiKeyId: string }) {
  const [logs, setLogs] = useState<RequestLogRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/settings/api-keys/${apiKeyId}/logs`)
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
      .catch(() => {
        if (!cancelled) {
          setLogs([])
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [apiKeyId])

  if (loading) return (
    <div className="flex items-center justify-center py-4 text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  )

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="text-xs font-medium mb-2 flex items-center gap-2">
        <Clock className="h-3.5 w-3.5" />
        Request Logs for this API Key
      </div>
        {logs.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            No requests yet. Call the API to see logs here.
          </p>
        ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[200px]">Endpoint</TableHead>
                <TableHead className="w-[70px]">Status</TableHead>
                <TableHead className="w-[90px]">Latency</TableHead>
                <TableHead className="w-[150px]">Time</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.slice(0, 20).map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="font-mono text-xs">{log.endpoint}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        log.status < 400
                          ? 'text-success'
                          : 'text-destructive'
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
                  <TableCell className="text-xs text-destructive max-w-[200px] truncate">
                    {log.errorMessage || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
