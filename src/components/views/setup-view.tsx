'use client'

import { useState } from 'react'
import { Loader2, CheckCircle2, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { extractError } from '@/lib/extract-error'

const STEPS = ['LLM API', 'Test Model', 'Document', 'Data Source', 'Test Chat'] as const

interface SetupViewProps {
  onDone: () => void
}

export function SetupView({ onDone }: SetupViewProps) {
  const [step, setStep] = useState(0)
  const next = () => setStep((s) => s + 1)
  const prev = () => setStep((s) => Math.max(0, s - 1))

  async function finish() {
    const res = await fetch('/api/setup/complete', { method: 'POST' })
    if (!res.ok) {
      toast.error('Failed to complete setup.')
      return
    }
    onDone()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Setup Wizard — {STEPS[step]}</CardTitle>
          <CardDescription>
            Step {step + 1} of {STEPS.length}
          </CardDescription>
          <Progress value={((step + 1) / STEPS.length) * 100} className="mt-2" />
        </CardHeader>
        <CardContent className="min-h-[280px]">
          {step === 0 && <LlmStep onNext={next} />}
          {step === 1 && <TestModelStep onNext={next} onPrev={prev} />}
          {step === 2 && <DocumentStep onNext={next} onPrev={prev} />}
          {step === 3 && <DataSourceStep onNext={next} onPrev={prev} />}
          {step === 4 && <TestChatStep onFinish={finish} onPrev={prev} />}
        </CardContent>
      </Card>
    </div>
  )
}

/* ------------------------------ Step 0: LLM ------------------------------ */

function LlmStep({ onNext }: { onNext: () => void }) {
  const [provider] = useState('openai-compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          baseUrl,
          apiKey: apiKey || undefined,
          model: model || undefined,
        }),
      })
      if (!res.ok) {
        toast.error('Failed to save LLM configuration')
        return
      }
      toast.success('LLM configuration saved')
    } catch {
      toast.error('Failed to save LLM configuration')
      return
    } finally {
      setSaving(false)
    }
    onNext()
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Connect an LLM provider (OpenAI-compatible). You can skip this step and configure it
        later in AI Configuration.
      </p>
      <div className="space-y-2">
        <Label htmlFor="llm-base">Base URL</Label>
        <Input
          id="llm-base"
          placeholder="https://api.openai.com/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="llm-key">API Key</Label>
        <Input
          id="llm-key"
          type="password"
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="llm-model">Model</Label>
        <Input
          id="llm-model"
          placeholder="gpt-4o-mini"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onNext} disabled={saving}>
          Skip
        </Button>
        <Button className="flex-1" onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save & Continue
        </Button>
      </div>
    </div>
  )
}

/* --------------------------- Step 2: Test Model -------------------------- */

function TestModelStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  const [syncing, setSyncing] = useState(false)
  const [modelCount, setModelCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSync() {
    setSyncing(true)
    setError(null)
    try {
      const res = await fetch('/api/llm-config/models', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed')
      setModelCount(Array.isArray(data?.data?.models) ? data.data.models.length : 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Verify the LLM connection by syncing the model list.
      </p>
      {modelCount !== null && (
        <div className="flex items-center gap-2 text-xs text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
          {modelCount} models available.
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onPrev}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button variant="outline" className="flex-1" onClick={onNext}>
          Skip
        </Button>
        <Button className="flex-1" onClick={handleSync} disabled={syncing}>
          {syncing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Test Connection
        </Button>
      </div>
      {modelCount !== null && (
        <Button variant="ghost" className="w-full" onClick={onNext}>
          Continue →
        </Button>
      )}
    </div>
  )
}

/* --------------------------- Step 3: Document ---------------------------- */

function DocumentStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState(false)
  const inputId = 'setup-doc-input'

  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/documents', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(extractError(err.error, 'Failed to upload'))
        return
      }
      setUploaded(true)
      toast.success('Document uploaded')
    } catch {
      toast.error('Failed to upload document')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Upload the first document for the knowledge base (RAG). You can skip and upload it
        later in Knowledge.
      </p>
      <Input
        id={inputId}
        type="file"
        accept=".txt,.pdf,.docx,.md"
        disabled={uploading}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleUpload(f)
        }}
      />
      {uploaded && (
        <div className="flex items-center gap-2 text-xs text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
          Document uploaded and indexing.
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onPrev} disabled={uploading}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button variant="outline" className="flex-1" onClick={onNext}>
          Skip
        </Button>
        {uploaded && (
          <Button className="flex-1" onClick={onNext}>
            Continue →
          </Button>
        )}
      </div>
    </div>
  )
}

/* -------------------------- Step 4: Data Source -------------------------- */

function DataSourceStep({ onNext, onPrev }: { onNext: () => void; onPrev: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Data Sources (SQL databases and REST APIs) can be configured after setup is complete via
        the Data Sources menu. You can connect PostgreSQL, MySQL, or REST endpoints to give the
        assistant read access to your internal data.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onPrev}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button className="flex-1" onClick={onNext}>
          Got it, Continue →
        </Button>
      </div>
    </div>
  )
}

/* ---------------------------- Step 5: Test Chat -------------------------- */

function TestChatStep({ onFinish, onPrev }: { onFinish: () => void; onPrev: () => void }) {
  const [message, setMessage] = useState('')
  const [reply, setReply] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [warned, setWarned] = useState(false)

  async function handleSend() {
    if (!message.trim()) return
    setSending(true)
    setReply(null)
    try {
      const createRes = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Setup Test' }),
      })
      const session = await createRes.json()
      const sendRes = await fetch(`/api/chat/sessions/${session.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      })
      if (!sendRes.ok) throw new Error('Failed')
      const data = await sendRes.json()
      setReply(data?.aiMessage?.content ?? '(empty)')
      setWarned(false)
    } catch {
      setWarned(true)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Test a conversation to ensure the LLM responds. You can complete setup even if this test
        fails.
      </p>
      <div className="space-y-2">
        <Label htmlFor="test-msg">Message</Label>
        <Textarea
          id="test-msg"
          placeholder="Hello, connection test."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={sending}
        />
      </div>
      <Button className="w-full" onClick={handleSend} disabled={sending || !message.trim()}>
        {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Send Test
      </Button>
      {reply && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <span className="font-medium">Reply: </span>
          {reply}
        </div>
      )}
      {warned && (
        <p className="text-xs text-amber-600">
          Chat test failed — make sure the LLM configuration is correct. You can still complete setup.
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onPrev} disabled={sending}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button className="flex-1" variant={warned ? 'destructive' : 'default'} onClick={onFinish}>
          Finish
        </Button>
      </div>
    </div>
  )
}
