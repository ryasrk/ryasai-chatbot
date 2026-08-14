'use client'

import { useState, useMemo, useRef } from 'react'
import {
  FlaskConical,
  Loader2,
  Send,
  Braces,
  Activity,
  ChevronDown,
  Copy,
  Download,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { KvPair, TestResponse } from './types'
import { prettyBody, copyText, downloadBody, statusBadgeClass } from './utils'

/* -------------------------------- Test -------------------------------- */

function KeyValueEditor({
  pairs,
  onChange,
  onAdd,
  keyPlaceholder,
  valuePlaceholder,
}: {
  pairs: KvPair[]
  onChange: (next: KvPair[]) => void
  onAdd: () => void
  keyPlaceholder: string
  valuePlaceholder: string
}) {
  return (
    <div className="space-y-2">
      {pairs.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">No rows yet.</p>
      ) : (
        pairs.map((pair) => (
          <div key={pair.id} className="flex gap-2">
            <Input
              className="text-xs"
              placeholder={keyPlaceholder}
              value={pair.key}
              onChange={(e) =>
                onChange(pairs.map((p) => (p.id === pair.id ? { ...p, key: e.target.value } : p)))
              }
            />
            <Input
              className="text-xs"
              placeholder={valuePlaceholder}
              value={pair.value}
              onChange={(e) =>
                onChange(pairs.map((p) => (p.id === pair.id ? { ...p, value: e.target.value } : p)))
              }
            />
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onChange(pairs.filter((p) => p.id !== pair.id))}
              aria-label="Delete row"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))
      )}
      <Button variant="outline" size="sm" className="text-xs" icon={<Plus className="h-3.5 w-3.5" />} onClick={onAdd}>
        Add
      </Button>
    </div>
  )
}

export function TestPanel() {
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<KvPair[]>([])
  const [params, setParams] = useState<KvPair[]>([])
  const [body, setBody] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [sending, setSending] = useState(false)
  const [response, setResponse] = useState<TestResponse | null>(null)
  const idRef = useRef(0)

  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
  const pretty = useMemo(() => (response ? prettyBody(response.body) : null), [response])
  const resHeaders = response ? Object.entries(response.headers) : []

  const addHeader = () => setHeaders((h) => [...h, { id: ++idRef.current, key: '', value: '' }])
  const addParam = () => setParams((p) => [...p, { id: ++idRef.current, key: '', value: '' }])

  function formatJson() {
    try {
      const parsed = JSON.parse(body)
      setBody(JSON.stringify(parsed, null, 2))
      toast.success('JSON formatted.')
    } catch {
      toast.error('Body is not valid JSON.')
    }
  }

  async function sendRequest() {
    if (!url.trim()) {
      toast.error('URL is required.')
      return
    }
    try { new URL(url.trim()) } catch {
      toast.error('Invalid URL.')
      return
    }
    setSending(true)
    setResponse(null)
    try {
      const headerObj: Record<string, string> = {}
      for (const h of headers) {
        const k = h.key.trim()
        if (k) headerObj[k] = h.value
      }
      if (authToken.trim()) {
        headerObj['Authorization'] = `Bearer ${authToken.trim()}`
      }
      const paramObj: Record<string, string> = {}
      for (const p of params) {
        const k = p.key.trim()
        if (k) paramObj[k] = p.value
      }
      const res = await fetch('/api/integration-api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          url: url.trim(),
          headers: headerObj,
          params: paramObj,
          body: hasBody ? body : undefined,
        }),
      })
      const data = (await res.json()) as TestResponse
      setResponse(data)
      if (!data.ok && data.error) {
        toast.error('Request failed', { description: data.error })
      }
    } catch (e) {
      toast.error('Failed to send request', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-xs flex items-center gap-2">
            <FlaskConical className="h-4 w-4" />
            Request Builder
          </CardTitle>
          <CardDescription className="text-xs">Build and send HTTP requests to test the API</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="w-[110px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="GET">GET</SelectItem>
                <SelectItem value="POST">POST</SelectItem>
                <SelectItem value="PUT">PUT</SelectItem>
                <SelectItem value="PATCH">PATCH</SelectItem>
                <SelectItem value="DELETE">DELETE</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="flex-1 text-xs"
              placeholder="https://api.example.com/endpoint"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Bearer Token (optional)</Label>
            <Input
              className="text-xs font-mono"
              placeholder="Bearer token automatically added to headers"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs">Headers</Label>
            <KeyValueEditor
              pairs={headers}
              onChange={setHeaders}
              onAdd={addHeader}
              keyPlaceholder="Header"
              valuePlaceholder="Value"
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-xs">Query Parameters</Label>
            <KeyValueEditor
              pairs={params}
              onChange={setParams}
              onAdd={addParam}
              keyPlaceholder="Parameter"
              valuePlaceholder="Value"
            />
          </div>

          {hasBody && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Body</Label>
                  <Button size="sm" variant="ghost" className="text-xs" icon={<Braces className="h-3.5 w-3.5" />} onClick={formatJson}>
                    Format JSON
                  </Button>
                </div>
                <Textarea
                  className="font-mono text-xs min-h-[140px]"
                  placeholder='{"key": "value"}'
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </div>
            </>
          )}

          <Button
            size="sm"
            icon={sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            onClick={sendRequest}
            disabled={sending || !url.trim()}
          >
            Send Request
          </Button>
        </CardContent>
      </Card>

      {response && (
        <Card>
          <CardHeader>
            <CardTitle className="text-xs flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Response
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              {response.ok ? (
                <Badge variant="outline" className={statusBadgeClass(response.statusCode)}>
                  {response.statusCode}
                </Badge>
              ) : (
                <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
                  Failed
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{response.latencyMs}ms</span>
              {response.error && (
                <span className="text-xs text-destructive truncate">{response.error}</span>
              )}
            </div>

            {resHeaders.length > 0 && (
              <Collapsible defaultOpen={false}>
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs group"
                    icon={<ChevronDown className="h-3.5 w-3.5 group-data-[state=open]:rotate-180 transition-transform" />}
                  >
                    Response Headers ({resHeaders.length})
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 rounded-md border overflow-x-auto">
                    <Table>
                      <TableBody>
                        {resHeaders.map(([k, v]) => (
                          <TableRow key={k}>
                            <TableCell className="font-mono text-xs text-muted-foreground w-[180px]">
                              {k}
                            </TableCell>
                            <TableCell className="font-mono text-xs break-all">{v}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}

            {response.body ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Body</Label>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      icon={<Copy className="h-3.5 w-3.5" />}
                      onClick={() => copyText(pretty?.text ?? response.body, 'Response copied.')}
                    >
                      Copy
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      icon={<Download className="h-3.5 w-3.5" />}
                      onClick={() => downloadBody(pretty?.text ?? response.body, pretty?.isJson ?? false)}
                    >
                      Download
                    </Button>
                  </div>
                </div>
                <pre className="bg-muted/60 rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-[400px] overflow-y-auto">
                  <code>{pretty?.text ?? response.body}</code>
                </pre>
              </div>
            ) : response.ok ? (
              <p className="text-xs text-muted-foreground py-4 text-center">Response body empty.</p>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
