'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  KeyRound,
  Plus,
  Trash2,
  Copy,
  Loader2,
  Terminal,
  Activity,
  Clock,
  BookOpen,
  FlaskConical,
  ScrollText,
  Send,
  ChevronDown,
  Download,
  Braces,
  Check,
  Plug,
  AlertTriangle,
} from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { enUS as localeId } from 'date-fns/locale'

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
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

interface ApiKeyRow {
  id: string
  isActive: boolean
  label: string
  maskedKey: string
  requestLimitPerMinute: number | null
  dailyRequestLimit: number | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

interface RequestLogRow {
  id: string
  endpoint: string
  status: number
  latencyMs: number | null
  errorMessage: string | null
  createdAt: string
}

interface TestResponse {
  ok: boolean
  statusCode: number
  latencyMs: number
  headers: Record<string, string>
  body: string
  error?: string
}

interface KvPair {
  id: number
  key: string
  value: string
}

async function copyText(text: string, message: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(message)
  } catch {
    toast.error('Failed to copy')
  }
}

function statusBadgeClass(status: number): string {
  if (status >= 200 && status < 300) return 'bg-success/15 text-success border-success/30'
  if (status >= 300 && status < 400) return 'bg-info/15 text-info border-info/30'
  if (status >= 400 && status < 500) return 'bg-warning/15 text-warning border-warning/30'
  return 'bg-destructive/15 text-destructive border-destructive/30'
}

function methodBadgeClass(method: string): string {
  switch (method) {
    case 'GET':
      return 'text-info border-info/40'
    case 'POST':
      return 'text-success border-success/40'
    case 'PUT':
    case 'PATCH':
      return 'text-warning border-warning/40'
    case 'DELETE':
      return 'text-destructive border-destructive/40'
    default:
      return ''
  }
}

function prettyBody(body: string): { text: string; isJson: boolean } {
  try {
    const parsed = JSON.parse(body)
    return { text: JSON.stringify(parsed, null, 2), isJson: true }
  } catch {
    return { text: body, isJson: false }
  }
}

function downloadBody(text: string, isJson: boolean) {
  const blob = new Blob([text], { type: isJson ? 'application/json' : 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = isJson ? 'response.json' : 'response.txt'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function IntegrationApiView() {
  const [tab, setTab] = useState('docs')
  return (
    <Tabs value={tab} onValueChange={setTab} className="w-full">
      <div className="overflow-x-auto -mx-1 px-1 pb-1">
        <TabsList className="w-max">
          <TabsTrigger value="docs" className="gap-1.5">
            <BookOpen className="h-3.5 w-3.5" />
            Documentation
          </TabsTrigger>
          <TabsTrigger value="test" className="gap-1.5">
            <FlaskConical className="h-3.5 w-3.5" />
            Test
          </TabsTrigger>
          <TabsTrigger value="keys" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />
            API Keys
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            Request Logs
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="docs" forceMount className="hidden data-[state=active]:block mt-3 space-y-3">
        <DocumentationPanel onSwitchTab={setTab} />
      </TabsContent>
      <TabsContent value="test" forceMount className="hidden data-[state=active]:block mt-3 space-y-3">
        <TestPanel />
      </TabsContent>
      <TabsContent value="keys" forceMount className="hidden data-[state=active]:block mt-3 space-y-3">
        <ApiKeysPanel />
      </TabsContent>
      <TabsContent value="logs" forceMount className="hidden data-[state=active]:block mt-3 space-y-3">
        <RequestLogsPanel />
      </TabsContent>
    </Tabs>
  )
}

/* ----------------------------- Documentation ----------------------------- */

function CodeBlock({ code, language = 'javascript', label }: { code: string; language?: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="overflow-hidden rounded-md border border-border/70">
      <div className="flex items-center justify-between border-b border-border bg-muted px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <Terminal className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {label ?? language}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
          onClick={() => {
            void navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
          )}
        </Button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={vscDarkPlus}
        customStyle={{ margin: 0, background: '#0a0a0a', fontSize: '12px', padding: '12px', maxHeight: '200px', overflowY: 'auto' }}
        codeTagProps={{ style: { fontFamily: 'var(--font-jetbrains), ui-monospace, SFMono-Regular, Menlo, monospace' } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

function DocSection({ title, icon, description, children, defaultOpen = false }: {
  title: React.ReactNode
  icon?: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <Card>
        <CollapsibleTrigger className="group w-full text-left">
          <CardHeader className="cursor-pointer hover:bg-muted/40 transition-colors select-none">
            <CardTitle className="text-xs flex items-center gap-2">
              {icon}
              {title}
              <ChevronDown className="h-3.5 w-3.5 ml-auto text-muted-foreground group-data-[state=open]:rotate-180 transition-transform" />
            </CardTitle>
            {description && <CardDescription className="text-xs">{description}</CardDescription>}
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-3">{children}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

const CHAT_REQUEST_BODY = `{
  "model": "ryasai",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello, how are you?" }
  ],
  "stream": false
}`

const CHAT_RESPONSE_BODY = `{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1721812345,
  "model": "ryasai",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! I'm well, how can I help you?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 24, "completion_tokens": 12, "total_tokens": 36 }
}`

const CHAT_SSE_EXAMPLE = `data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1721812345,"model":"ryasai","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1721812345,"model":"ryasai","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1721812345,"model":"ryasai","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1721812345,"model":"ryasai","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]`

const AGENT_REQUEST_BODY = `{
  "question": "What is the total sales this month according to the database?",
  "sessionId": "optional-session-id"
}`

const AGENT_RESPONSE_BODY = `{
  "ok": true,
  "answer": "Total sales this month is Rp 42,500,000.",
  "steps": [
    {
      "stepId": "s1",
      "tool": "sql",
      "status": "success",
      "input": "SELECT SUM(amount) FROM sales WHERE month = current_month",
      "output": "42500000",
      "latencyMs": 320
    }
  ]
}`

const ERROR_429_BODY = `{
  "error": {
    "type": "rate_limit_exceeded",
    "message": "Rate limit reached. Try again in 60 seconds.",
    "retryAfter": 60
  }
}`

const ERROR_CODES: Array<[string, string, string]> = [
  ['400', 'Bad Request', 'Invalid request body or missing required field.'],
  ['401', 'Unauthorized', 'Authorization header missing.'],
  ['403', 'Forbidden', 'API key invalid or revoked.'],
  ['429', 'Too Many Requests', 'Rate limit reached for this API key.'],
  ['500', 'Internal Server Error', 'Unexpected server error.'],
  ['503', 'Service Unavailable', 'LLM not configured or currently unavailable.'],
]

function DocumentationPanel({ onSwitchTab }: { onSwitchTab: (tab: string) => void }) {
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => '',
  )

  const baseUrl = origin ? `${origin}/api/v1` : 'https://your-dashboard.com/api/v1'

  const chatCurl = `curl -X POST ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer rya_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '${CHAT_REQUEST_BODY}'`

  const chatJs = `const response = await fetch('${baseUrl}/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer rya_your_key_here',
  },
  body: JSON.stringify({
    model: 'ryasai',
    messages: [{ role: 'user', content: 'Hello!' }],
  }),
});
const data = await response.json();
console.log(data.choices[0].message.content);`

  const chatPython = `import requests

resp = requests.post(
    '${baseUrl}/chat/completions',
    headers={'Authorization': 'Bearer rya_your_key_here'},
    json={
        'model': 'ryasai',
        'messages': [{'role': 'user', 'content': 'Hello!'}],
    },
)
print(resp.json()['choices'][0]['message']['content'])`

  const agentCurl = `curl -X POST ${baseUrl}/agent/run \\
  -H "Authorization: Bearer rya_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '${AGENT_REQUEST_BODY}'`

  return (
    <div className="space-y-3">
      <DocSection
        title="ryasai Chatbot API"
        icon={<BookOpen className="h-4 w-4" />}
        description="OpenAI-style API integration to embed into your website or system"
        defaultOpen
      >
        <div className="space-y-1.5">
          <Label className="text-xs">Base URL</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 block rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-xs break-all">
              {baseUrl}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => copyText(baseUrl, 'Base URL copied.')}
            >
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
          </div>
        </div>
      </DocSection>

      <DocSection
        title="Authentication"
        icon={<KeyRound className="h-4 w-4" />}
        description="Every request must include a Bearer token"
      >
        <p className="text-xs text-muted-foreground">
          All endpoints require the header{' '}
          <code className="font-mono">Authorization: Bearer &lt;API_KEY&gt;</code>. Create an API key
          in the API Keys tab, then use its value (prefixed with <code className="font-mono">rya_</code>)
          in every request.
        </p>
        <Button size="sm" variant="outline" onClick={() => onSwitchTab('keys')}>
          <KeyRound className="h-3.5 w-3.5" />
          Open API Keys tab
        </Button>
        <CodeBlock code="Authorization: Bearer rya_xxxxxxxxxxxx" language="text" label="header" />
      </DocSection>

      <DocSection
        title={
          <>
            <Badge variant="outline" className={methodBadgeClass('POST')}>POST</Badge>
            <span className="font-mono text-xs">/api/v1/chat/completions</span>
          </>
        }
        icon={<Terminal className="h-4 w-4" />}
        description="OpenAI-compatible chat completion"
      >
        <div className="space-y-1.5">
          <Label className="text-xs">Request Body</Label>
          <CodeBlock code={CHAT_REQUEST_BODY} language="json" label="json" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Response (stream: false)</Label>
          <CodeBlock code={CHAT_RESPONSE_BODY} language="json" label="json" />
        </div>
        <Alert>
          <Activity className="h-4 w-4" />
          <AlertTitle>Streaming</AlertTitle>
          <AlertDescription className="text-xs">
            Set <code className="font-mono">stream: true</code> to receive Server-Sent Events
            (SSE). Each chunk is a <code className="font-mono">chat.completion.chunk</code>{' '}
            with a <code className="font-mono">delta</code> field, terminated by{' '}
            <code className="font-mono">data: [DONE]</code>.
          </AlertDescription>
        </Alert>
        <CodeBlock code={CHAT_SSE_EXAMPLE} language="text" label="sse" />
        <div className="space-y-1.5">
          <Label className="text-xs">curl</Label>
          <CodeBlock code={chatCurl} language="bash" label="bash" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">JavaScript (fetch)</Label>
          <CodeBlock code={chatJs} language="javascript" label="javascript" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Python (requests)</Label>
          <CodeBlock code={chatPython} language="python" label="python" />
        </div>
      </DocSection>

      <DocSection
        title={
          <>
            <Badge variant="outline" className={methodBadgeClass('POST')}>POST</Badge>
            <span className="font-mono text-xs">/api/v1/agent/run</span>
          </>
        }
        icon={<Terminal className="h-4 w-4" />}
        description="Multi-step agent execution (planner + tool registry)"
      >
        <div className="space-y-1.5">
          <Label className="text-xs">Request Body</Label>
          <CodeBlock code={AGENT_REQUEST_BODY} language="json" label="json" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Response</Label>
          <CodeBlock code={AGENT_RESPONSE_BODY} language="json" label="json" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">curl</Label>
          <CodeBlock code={agentCurl} language="bash" label="bash" />
        </div>
      </DocSection>

      <DocSection
        title="Embedding Guide"
        icon={<Plug className="h-4 w-4" />}
        description="Copy-paste examples to embed the chatbot into your website"
      >
        <div className="space-y-1.5">
          <Label className="text-xs">JavaScript</Label>
          <CodeBlock code={chatJs} language="javascript" label="javascript" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Python</Label>
          <CodeBlock code={chatPython} language="python" label="python" />
        </div>
      </DocSection>

      <DocSection
        title="Rate Limits"
        icon={<Activity className="h-4 w-4" />}
        description="Request limits per API key, configured at key creation"
      >
        <p className="text-xs text-muted-foreground">
          Each API key can be limited with{' '}
          <code className="font-mono">requestLimitPerMinute</code> (req/min) and{' '}
          <code className="font-mono">dailyRequestLimit</code> (req/day). Limits are set at key
          creation and can be viewed in the API Keys tab.
        </p>
        <div className="space-y-1.5">
          <Label className="text-xs">429 Response</Label>
          <CodeBlock code={ERROR_429_BODY} language="json" label="json" />
        </div>
      </DocSection>

      <DocSection
        title="Error Codes"
        icon={<AlertTriangle className="h-4 w-4" />}
        description="List of HTTP status codes that may be returned"
      >
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[70px]">Status</TableHead>
                <TableHead className="w-[180px]">Name</TableHead>
                <TableHead>Cause</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ERROR_CODES.map(([code, name, desc]) => (
                <TableRow key={code}>
                  <TableCell>
                    <Badge variant="outline" className={statusBadgeClass(Number(code))}>
                      {code}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{desc}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DocSection>
    </div>
  )
}

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
      <Button variant="outline" size="sm" className="text-xs" onClick={onAdd}>
        <Plus className="h-3.5 w-3.5" />
        Add
      </Button>
    </div>
  )
}

function TestPanel() {
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
        <CardContent className="space-y-4">
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
                  <Button size="sm" variant="ghost" className="text-xs" onClick={formatJson}>
                    <Braces className="h-3.5 w-3.5" />
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

          <Button onClick={sendRequest} disabled={sending || !url.trim()}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              {response.ok ? (
                <Badge variant="outline" className={statusBadgeClass(response.statusCode)}>
                  {response.statusCode}
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-red-500/15 text-red-600 border-red-500/30">
                  Failed
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{response.latencyMs}ms</span>
              {response.error && (
                <span className="text-xs text-rose-600 truncate">{response.error}</span>
              )}
            </div>

            {resHeaders.length > 0 && (
              <Collapsible defaultOpen={false}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs group">
                    <ChevronDown className="h-3.5 w-3.5 group-data-[state=open]:rotate-180 transition-transform" />
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
                      onClick={() => copyText(pretty?.text ?? response.body, 'Response copied.')}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      onClick={() => downloadBody(pretty?.text ?? response.body, pretty?.isJson ?? false)}
                    >
                      <Download className="h-3.5 w-3.5" />
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

/* ----------------------------- API Keys Panel ----------------------------- */

function ApiKeysPanel() {
  const [items, setItems] = useState<ApiKeyRow[]>([])
  const [loading, setLoading] = useState(true)
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
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Failed to create API key.')
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
        throw new Error(json.error ?? 'Failed to revoke API key.')
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
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
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
                          className="text-rose-600 hover:text-rose-700"
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
    </div>
  )
}

/* --------------------------- All Request Logs --------------------------- */

function RequestLogsPanel() {
  const [logs, setLogs] = useState<RequestLogRow[]>([])
  const [loading, setLoading] = useState(true)
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
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
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
