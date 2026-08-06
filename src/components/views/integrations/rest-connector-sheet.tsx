'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Globe,
  Loader2,
  Plus,
  ShieldAlert,
  Terminal,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Delayed, FormSkeleton } from '@/components/ui/view-states'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { extractError } from '@/lib/extract-error'
import { RestConnectorItem, RestConnectorDetail } from './types'

export function RestConnectorSheet({
  connector,
  onClose,
  onChanged,
}: {
  connector: RestConnectorItem | null
  onClose: () => void
  onChanged: () => void
}) {
  return (
    <Sheet open={!!connector} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-[680px] w-full flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4" />
            REST API — {connector?.name ?? ''}
          </SheetTitle>
          <SheetDescription>
            Manage endpoint whitelist and test requests that can be used by the chatbot.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 mt-2">
          {connector && (
            <RestConnectorContent
              key={connector.id}
              connector={connector}
              onChanged={onChanged}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function RestConnectorContent({
  connector,
  onChanged,
}: {
  connector: RestConnectorItem
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<RestConnectorDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [testMethod, setTestMethod] = useState('GET')
  const [testPath, setTestPath] = useState('')
  const [testQuery, setTestQuery] = useState('')
  const [testBody, setTestBody] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<unknown>(null)
  const [deletingEndpointId, setDeletingEndpointId] = useState<string | null>(null)

  const fetchDetail = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/data-sources/rest-connectors/${connector.id}`, {
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok && json.ok) {
        setDetail(json.data as RestConnectorDetail)
      } else {
        setError(extractError(json.error, 'Failed to load REST connector.'))
      }
    } catch (e) {
      console.error(e)
      setError('Network error while loading REST connector.')
    } finally {
      setLoading(false)
    }
  }, [connector.id])

  useEffect(() => {
    fetchDetail()
  }, [fetchDetail])

  const handleToggleActive = async (checked: boolean) => {
    try {
      const res = await fetch(`/api/data-sources/rest-connectors/${connector.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: checked }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        toast.error(extractError(json.error, 'Failed to change status.'))
        return
      }
      toast.success(checked ? 'REST connector enabled.' : 'REST connector disabled.')
      setDetail((prev) => (prev ? { ...prev, isActive: checked } : prev))
      onChanged()
    } catch (e) {
      toast.error('Network error while changing status.')
      console.error(e)
    }
  }

  const handleAddEndpoint = async () => {
    const trimmedPath = path.trim()
    if (!trimmedPath) {
      toast.error('Endpoint path is required.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/data-sources/rest-connectors/${connector.id}/endpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          path: trimmedPath,
          description: description.trim() || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to add endpoint.'))
      toast.success('Endpoint whitelist added.')
      setPath('')
      setDescription('')
      await fetchDetail()
      onChanged()
    } catch (e) {
      toast.error('Failed to add endpoint', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleTestEndpoint = async () => {
    const trimmedPath = testPath.trim()
    if (!trimmedPath) {
      toast.error('Test path is required.')
      return
    }

    let parsedBody: unknown
    if (testBody.trim()) {
      try {
        parsedBody = JSON.parse(testBody)
      } catch {
        toast.error('Body must be valid JSON.')
        return
      }
    }

    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(`/api/data-sources/rest-connectors/${connector.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: testMethod,
          path: trimmedPath,
          query: parseQueryPairs(testQuery),
          body: parsedBody,
        }),
      })
      const json = await res.json()
      setTestResult(json)
      if (res.ok && json.ok) toast.success('REST endpoint tested successfully.')
      else toast.error(extractError(json.error, 'REST endpoint failed to test.'))
    } catch (e) {
      console.error(e)
      toast.error('Network error while testing endpoint.')
    } finally {
      setTesting(false)
    }
  }

  const handleDeleteEndpoint = async (endpointId: string) => {
    setDeletingEndpointId(endpointId)
    try {
      const res = await fetch(
        `/api/data-sources/rest-connectors/${connector.id}/endpoints/${endpointId}`,
        { method: 'DELETE' },
      )
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to delete endpoint.'))
      toast.success('Endpoint whitelist deleted.')
      await fetchDetail()
      onChanged()
    } catch (e) {
      toast.error('Failed to delete endpoint', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setDeletingEndpointId(null)
    }
  }

  if (loading) {
    return <Delayed><FormSkeleton fields={4} /></Delayed>
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  if (!detail) return null

  return (
    <ScrollArea className="h-full pr-2">
      <div className="space-y-4">
        <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium">{detail.name}</div>
              <div className="font-mono text-xs text-muted-foreground truncate">
                {detail.baseUrl}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-medium text-muted-foreground">
                {detail.isActive ? 'ACTIVE' : 'INACTIVE'}
              </span>
              <Switch
                checked={detail.isActive}
                onCheckedChange={handleToggleActive}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">{detail.authType}</Badge>
            <Badge variant="outline">{detail.timeoutMs}ms timeout</Badge>
            <Badge variant="outline">{detail.endpoints.length} endpoint</Badge>
          </div>
        </div>

        <div className="rounded-lg border p-3 space-y-3">
          <div>
            <div className="text-sm font-medium">Add Endpoint Whitelist</div>
            <p className="text-xs text-muted-foreground">
              Only endpoints in this list can be called by test requests and the chatbot router.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="sm:col-span-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/customers"
              className="sm:col-span-4 font-mono text-sm"
            />
          </div>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description for AI, e.g. fetch list of active customers"
          />
          <Button
            onClick={handleAddEndpoint}
            disabled={submitting || !path.trim()}
            size="sm"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add Endpoint
          </Button>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Method</TableHead>
                <TableHead className="text-xs">Path</TableHead>
                <TableHead className="text-xs">Description</TableHead>
                <TableHead className="text-xs text-right">Status</TableHead>
                <TableHead className="text-xs text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.endpoints.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-8">
                    No endpoint whitelist yet.
                  </TableCell>
                </TableRow>
              ) : (
                detail.endpoints.map((endpoint) => (
                  <TableRow
                    key={endpoint.id}
                    className="cursor-pointer"
                    onClick={() => {
                      setTestMethod(endpoint.method)
                      setTestPath(endpoint.path)
                    }}
                  >
                    <TableCell className="font-mono text-xs">{endpoint.method}</TableCell>
                    <TableCell className="font-mono text-xs">{endpoint.path}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {endpoint.description ?? '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={endpoint.isEnabled ? 'default' : 'secondary'}>
                        {endpoint.isEnabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        disabled={deletingEndpointId === endpoint.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteEndpoint(endpoint.id)
                        }}
                      >
                        {deletingEndpointId === endpoint.id ? (
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

        <div className="rounded-lg border p-3 space-y-3">
          <div>
            <div className="text-sm font-medium">Test Endpoint</div>
            <p className="text-xs text-muted-foreground">
              Click an endpoint in the table to fill method and path, then run the request.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
            <Select value={testMethod} onValueChange={setTestMethod}>
              <SelectTrigger className="sm:col-span-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={testPath}
              onChange={(e) => setTestPath(e.target.value)}
              placeholder="/customers"
              className="sm:col-span-4 font-mono text-sm"
            />
          </div>
          <Input
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            placeholder="limit=10&status=active"
            className="font-mono text-sm"
          />
          {testMethod !== 'GET' && (
            <Textarea
              value={testBody}
              onChange={(e) => setTestBody(e.target.value)}
              rows={4}
              placeholder='{"name":"Example"}'
              className="font-mono text-xs resize-none"
            />
          )}
          <Button
            onClick={handleTestEndpoint}
            disabled={testing || !testPath.trim()}
            size="sm"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Terminal className="h-4 w-4" />}
            Run Test
          </Button>
          {testResult !== null && (
            <pre className="max-h-[260px] overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
              <code>{JSON.stringify(testResult, null, 2)}</code>
            </pre>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

function parseQueryPairs(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw.trim().replace(/^\?/, ''))
  return Object.fromEntries(params.entries())
}
