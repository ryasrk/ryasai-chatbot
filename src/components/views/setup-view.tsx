'use client'

import { useState, type FormEvent } from 'react'
import { Loader2, CheckCircle2 } from 'lucide-react'
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

const STEPS = ['Akun Admin', 'LLM API', 'Tes Model', 'Dokumen', 'Data Source', 'Tes Chat'] as const

interface SetupViewProps {
  hasAdmin: boolean
  onDone: () => void
}

export function SetupView({ hasAdmin, onDone }: SetupViewProps) {
  const [step, setStep] = useState(hasAdmin ? 1 : 0)
  const next = () => setStep((s) => s + 1)

  async function finish() {
    await fetch('/api/setup/complete', { method: 'POST' })
    onDone()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Setup Awal — {STEPS[step]}</CardTitle>
          <CardDescription>
            Langkah {step + 1} dari {STEPS.length}
          </CardDescription>
          <Progress value={((step + 1) / STEPS.length) * 100} className="mt-2" />
        </CardHeader>
        <CardContent className="min-h-[280px]">
          {step === 0 && <AdminStep onNext={next} />}
          {step === 1 && <LlmStep onNext={next} />}
          {step === 2 && <TestModelStep onNext={next} />}
          {step === 3 && <DocumentStep onNext={next} />}
          {step === 4 && <DataSourceStep onNext={next} />}
          {step === 5 && <TestChatStep onFinish={finish} />}
        </CardContent>
      </Card>
    </div>
  )
}

/* ----------------------------- Step 0: Admin ----------------------------- */

function AdminStep({ onNext }: { onNext: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/setup/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        onNext()
        return
      }
      setError(data?.error || 'Gagal membuat akun admin.')
    } catch {
      setError('Tidak dapat terhubung ke server.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Buat akun admin pertama. Anda akan otomatis masuk setelah akun dibuat.
      </p>
      <div className="space-y-2">
        <Label htmlFor="setup-name">Nama</Label>
        <Input
          id="setup-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="setup-email">Email</Label>
        <Input
          id="setup-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="setup-password">Password</Label>
        <Input
          id="setup-password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Buat Akun & Lanjut
      </Button>
    </form>
  )
}

/* ------------------------------ Step 1: LLM ------------------------------ */

function LlmStep({ onNext }: { onNext: () => void }) {
  const [provider] = useState('openai-compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          baseUrl,
          apiKey: apiKey || undefined,
          model: model || undefined,
        }),
      })
      toast.success('Konfigurasi LLM tersimpan')
    } catch {
      /* ignore — skippable */
    } finally {
      setSaving(false)
    }
    onNext()
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Hubungkan penyedia LLM (OpenAI-compatible). Anda bisa melewati langkah ini dan mengaturnya
        nanti di AI Configuration.
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
          Lewati
        </Button>
        <Button className="flex-1" onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Simpan & Lanjut
        </Button>
      </div>
    </div>
  )
}

/* --------------------------- Step 2: Test Model -------------------------- */

function TestModelStep({ onNext }: { onNext: () => void }) {
  const [syncing, setSyncing] = useState(false)
  const [modelCount, setModelCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSync() {
    setSyncing(true)
    setError(null)
    try {
      const res = await fetch('/api/llm-config/models', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Gagal')
      setModelCount(Array.isArray(data?.models) ? data.models.length : 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Verifikasi koneksi LLM dengan menyinkronkan daftar model.
      </p>
      {modelCount !== null && (
        <div className="flex items-center gap-2 text-sm text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
          {modelCount} model tersedia.
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onNext}>
          Lewati
        </Button>
        <Button className="flex-1" onClick={handleSync} disabled={syncing}>
          {syncing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Tes Koneksi
        </Button>
      </div>
      {modelCount !== null && (
        <Button variant="ghost" className="w-full" onClick={onNext}>
          Lanjut →
        </Button>
      )}
    </div>
  )
}

/* --------------------------- Step 3: Document ---------------------------- */

function DocumentStep({ onNext }: { onNext: () => void }) {
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState(false)
  const inputId = 'setup-doc-input'

  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/documents', { method: 'POST', body: form })
      if (res.ok) {
        setUploaded(true)
        toast.success('Dokumen diunggah')
      }
    } catch {
      /* ignore */
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Unggah dokumen pertama untuk knowledge base (RAG). Anda bisa melewati dan mengunggahnya
        nanti di Knowledge.
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
        <div className="flex items-center gap-2 text-sm text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
          Dokumen terunggah dan sedang diindeks.
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onNext}>
          Lewati
        </Button>
        {uploaded && (
          <Button className="flex-1" onClick={onNext}>
            Lanjut →
          </Button>
        )}
      </div>
    </div>
  )
}

/* -------------------------- Step 4: Data Source -------------------------- */

function DataSourceStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Data Sources (database SQL dan REST API) dapat dikonfigurasi setelah setup selesai melalui
        menu Data Sources. Anda dapat menghubungkan PostgreSQL, MySQL, atau REST endpoint untuk
        memberikan asisten akses baca ke data internal Anda.
      </p>
      <Button className="w-full" onClick={onNext}>
        Mengerti, Lanjut →
      </Button>
    </div>
  )
}

/* ---------------------------- Step 5: Test Chat -------------------------- */

function TestChatStep({ onFinish }: { onFinish: () => void }) {
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
      if (!sendRes.ok) throw new Error('Gagal')
      const data = await sendRes.json()
      setReply(data?.aiMessage?.content ?? '(kosong)')
      setWarned(false)
    } catch {
      setWarned(true)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Tes satu percakapan untuk memastikan LLM merespons. Anda bisa menyelesaikan setup bahkan
        jika tes ini gagal.
      </p>
      <div className="space-y-2">
        <Label htmlFor="test-msg">Pesan</Label>
        <Textarea
          id="test-msg"
          placeholder="Halo, tes koneksi."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={sending}
        />
      </div>
      <Button className="w-full" onClick={handleSend} disabled={sending || !message.trim()}>
        {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Kirim Tes
      </Button>
      {reply && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <span className="font-medium">Balasan: </span>
          {reply}
        </div>
      )}
      {warned && (
        <p className="text-sm text-amber-600">
          Tes chat gagal — pastikan konfigurasi LLM benar. Anda tetap dapat menyelesaikan setup.
        </p>
      )}
      <Button className="w-full" variant={warned ? 'destructive' : 'default'} onClick={onFinish}>
        Selesai
      </Button>
    </div>
  )
}
