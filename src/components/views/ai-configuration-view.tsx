'use client'

import { useEffect, useState } from 'react'
import {
  Bot,
  ShieldCheck,
  KeyRound,
  Server,
  RefreshCw,
  Save,
  Eye,
  EyeOff,
  Loader2,
  Plug,
  CheckCircle2,
} from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { id as localeId } from 'date-fns/locale'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
import type { ActiveUser, PublicLlmConfig } from '@/lib/types'

/**
 * AI Configuration view — provider, model, and embedding settings.
 * Moved here from the Settings view's "AI / LLM" tab so Settings stays
 * focused on org/admin/API-keys while AI configuration is a first-class view.
 */
export function AIConfigurationView() {
  const [role, setRole] = useState<ActiveUser['role'] | null>(null)
  const [cfg, setCfg] = useState<PublicLlmConfig | null>(null)
  const [loading, setLoading] = useState(true)

  const [provider, setProvider] = useState('OPENAI_COMPATIBLE')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [embeddingProvider, setEmbeddingProvider] = useState('OPENAI_COMPATIBLE')
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState('')
  const [embeddingApiKey, setEmbeddingApiKey] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [showEmbeddingKey, setShowEmbeddingKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/me', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/llm-config', { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(([me, llm]) => {
        if (cancelled) return
        if (me) setRole(me.role)
        if (llm?.ok && llm.data) {
          setCfg(llm.data)
          setProvider(llm.data.provider || 'OPENAI_COMPATIBLE')
          setBaseUrl(llm.data.baseUrl || '')
          setModel(llm.data.model || '')
          setModels(llm.data.availableModels || [])
          setEmbeddingProvider(llm.data.embeddingProvider || 'OPENAI_COMPATIBLE')
          setEmbeddingBaseUrl(llm.data.embeddingBaseUrl || llm.data.baseUrl || '')
          setEmbeddingModel(llm.data.embeddingModel || '')
        }
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  const isAdmin = role === 'admin'

  async function handleFetchModels() {
    setSyncing(true)
    try {
      const res = await fetch('/api/llm-config/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey: apiKey || undefined }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? 'Gagal mengambil model.')
      }
      const list: string[] = json.data.models ?? []
      setModels(list)
      // Reconcile: if the saved/current model isn't in the fresh list, snap to the first.
      if (list.length > 0 && !list.includes(model)) setModel(list[0])
      toast.success(`${list.length} model ditemukan`, {
        description: baseUrl ? `Dari ${baseUrl}` : undefined,
      })
    } catch (e) {
      toast.error('Gagal mengambil daftar model', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSyncing(false)
    }
  }

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
          embeddingProvider,
          embeddingBaseUrl: embeddingBaseUrl || undefined,
          embeddingApiKey: embeddingApiKey || undefined,
          embeddingModel: embeddingModel || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? 'Gagal menyimpan.')
      }
      if (json.data) {
        setCfg(json.data)
        setApiKey('')
        setEmbeddingApiKey('')
      }
      toast.success('Konfigurasi LLM tersimpan')
    } catch (e) {
      toast.error('Gagal menyimpan konfigurasi', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Konfigurasi LLM
          </CardTitle>
          <CardDescription>
            Hubungkan penyedia OpenAI-compatible (base URL + API key). Model dipilih dari daftar yang
            diambil dari <code className="font-mono text-[11px]">{`{base_url}/models`}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* status row */}
          <div className="flex flex-wrap items-center gap-2">
            {cfg?.configured ? (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                <CheckCircle2 className="h-3 w-3" /> Terkonfigurasi
              </Badge>
            ) : (
              <Badge variant="secondary">Belum dikonfigurasi</Badge>
            )}
            {cfg?.apiKeyMasked && (
              <Badge variant="outline" className="font-mono text-[10px]">
                <KeyRound className="h-3 w-3" /> {cfg.apiKeyMasked}
              </Badge>
            )}
            {cfg?.lastModelSyncAt && (
              <span className="text-[11px] text-muted-foreground">
                Model disinkronkan {format(new Date(cfg.lastModelSyncAt), 'dd MMM yyyy, HH:mm', { locale: localeId })}
              </span>
            )}
          </div>

          {!isAdmin && (
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>Admin only</AlertTitle>
              <AlertDescription>
                Hanya admin yang dapat mengubah konfigurasi LLM. Anda dapat melihat pengaturan saat ini.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="llm-provider">Provider</Label>
              <Select value={provider} onValueChange={setProvider} disabled={!isAdmin}>
                <SelectTrigger id="llm-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPENAI_COMPATIBLE">OpenAI-Compatible</SelectItem>
                  <SelectItem value="OPENAI">OpenAI</SelectItem>
                  <SelectItem value="GROQ">Groq</SelectItem>
                  <SelectItem value="OPENROUTER">OpenRouter</SelectItem>
                  <SelectItem value="ANTHROPIC">Anthropic</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="llm-baseurl">Base URL</Label>
              <Input
                id="llm-baseurl"
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={!isAdmin}
                className="font-mono text-sm"
              />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="llm-apikey">API Key</Label>
              <div className="relative">
                <Input
                  id="llm-apikey"
                  type="text"
                  placeholder={cfg?.apiKeyMasked ? `${cfg.apiKeyMasked}  (biarkan kosong untuk mempertahankan)` : 'sk-...'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={!isAdmin}
                  className={cn(
                    'pr-10 font-mono text-sm',
                    !showKey && 'text-security-disc',
                  )}
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showKey ? 'Sembunyikan' : 'Tampilkan'}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="llm-model">Model</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleFetchModels}
                  disabled={!isAdmin || syncing || !baseUrl}
                  className="gap-1.5"
                >
                  {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Ambil Model
                </Button>
              </div>
              {models.length > 0 ? (
                <Select value={model} onValueChange={setModel} disabled={!isAdmin}>
                  <SelectTrigger id="llm-model">
                    <SelectValue placeholder="Pilih model" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {models.map((m) => (
                      <SelectItem key={m} value={m} className="font-mono text-xs">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="llm-model"
                  placeholder="gpt-4o-mini  (klik 'Ambil Model' untuk daftar)"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={!isAdmin}
                  className="font-mono text-sm"
                />
              )}
              {models.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Klik <strong>Ambil Model</strong> untuk memuat daftar dari {baseUrl || 'base URL'}.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <div>
              <div className="text-sm font-medium">Embedding RAG</div>
              <p className="text-xs text-muted-foreground">
                Dipakai untuk hybrid retrieval. OpenAI-compatible memakai{' '}
                <code className="rounded bg-muted px-1 font-mono text-[11px]">
                  /embeddings
                </code>{' '}
                dan Ollama memakai{' '}
                <code className="rounded bg-muted px-1 font-mono text-[11px]">
                  /api/embed
                </code>.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="embedding-provider">Provider Embedding</Label>
                <Select
                  value={embeddingProvider}
                  onValueChange={setEmbeddingProvider}
                  disabled={!isAdmin}
                >
                  <SelectTrigger id="embedding-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OPENAI_COMPATIBLE">OpenAI-Compatible</SelectItem>
                    <SelectItem value="OPENAI">OpenAI</SelectItem>
                    <SelectItem value="OLLAMA">Ollama API</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="embedding-baseurl">Base URL Embedding</Label>
                <Input
                  id="embedding-baseurl"
                  placeholder={
                    embeddingProvider === 'OLLAMA'
                      ? 'http://localhost:11434'
                      : 'https://api.openai.com/v1'
                  }
                  value={embeddingBaseUrl}
                  onChange={(e) => setEmbeddingBaseUrl(e.target.value)}
                  disabled={!isAdmin}
                  className="font-mono text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="embedding-model">Model Embedding</Label>
                <Input
                  id="embedding-model"
                  placeholder={
                    embeddingProvider === 'OLLAMA'
                      ? 'nomic-embed-text'
                      : 'text-embedding-3-small'
                  }
                  value={embeddingModel}
                  onChange={(e) => setEmbeddingModel(e.target.value)}
                  disabled={!isAdmin}
                  className="font-mono text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="embedding-apikey">API Key Embedding</Label>
                <div className="relative">
                  <Input
                    id="embedding-apikey"
                    type="text"
                    placeholder={
                      cfg?.embeddingApiKeyMasked
                        ? `${cfg.embeddingApiKeyMasked}  (biarkan kosong)`
                        : embeddingProvider === 'OLLAMA'
                          ? 'opsional untuk Ollama'
                          : 'sk-...'
                    }
                    value={embeddingApiKey}
                    onChange={(e) => setEmbeddingApiKey(e.target.value)}
                    disabled={!isAdmin}
                    className={cn(
                      'pr-10 font-mono text-sm',
                      !showEmbeddingKey && 'text-security-disc',
                    )}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowEmbeddingKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showEmbeddingKey ? 'Sembunyikan' : 'Tampilkan'}
                  >
                    {showEmbeddingKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={handleSave} disabled={!isAdmin || saving || !baseUrl} className="gap-1.5">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Simpan Konfigurasi
            </Button>
          </div>
        </CardContent>
      </Card>

      <Alert>
        <Plug className="h-4 w-4" />
        <AlertTitle>OpenAI-Compatible</AlertTitle>
        <AlertDescription>
          Semua panggilan AI (routing, Text-to-SQL, jawaban RAG, chat) diarahkan ke endpoint
          API ini. Sistem tidak menjalankan inference lokal; model internal hanya boleh dipakai
          jika tersedia sebagai endpoint API OpenAI-compatible.
        </AlertDescription>
      </Alert>
    </div>
  )
}
