'use client'

import { useState, useSyncExternalStore } from 'react'
import {
  BookOpen,
  KeyRound,
  Terminal,
  Activity,
  Plug,
  AlertTriangle,
  ChevronDown,
  Check,
  Copy,
} from 'lucide-react'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import vscDarkPlus from 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { copyText, statusBadgeClass, methodBadgeClass } from './utils'

/* ----------------------------- Documentation ----------------------------- */

// ponytail: PrismLight + the 4 languages these docs actually use. The full
// `Prism` build ships refractor's ~290 grammars (1.2 MB) to highlight some curl
// and JSON. Unregistered languages ("text", "sse") render as plain code.
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('python', python)

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

export function DocumentationPanel({ onSwitchTab }: { onSwitchTab: (tab: string) => void }) {
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
