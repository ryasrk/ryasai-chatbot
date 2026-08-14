'use client'

import { useEffect, useState } from 'react'
import {
  Bot,
  KeyRound,
  Server,
  RefreshCw,
  Save,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle2,
} from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FormSkeleton } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
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
import { cn } from '@/lib/utils'
import type { PublicLlmConfig } from '@/lib/types'
import { extractError } from '@/lib/extract-error'

/**
 * AI Configuration view — provider, model, and embedding settings.
 * Moved here from the Settings view's "AI / LLM" tab so Settings stays
 * focused on org/admin/API-keys while AI configuration is a first-class view.
 */
export function AIConfigurationView() {
  const [cfg, setCfg] = useState<PublicLlmConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)

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
    fetch('/api/llm-config', { cache: 'no-store' })
      .then((r) => r.json())
      .then((llm) => {
        if (cancelled) return
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
    return showSkeleton ? <FormSkeleton fields={5} /> : null
  }

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
        throw new Error(extractError(json?.error, 'Failed to fetch models.'))
      }
      const list: string[] = json.data.models ?? []
      setModels(list)
      // Reconcile: if the saved/current model isn't in the fresh list, snap to the first.
      if (list.length > 0 && !list.includes(model)) setModel(list[0])
      toast.success(`${list.length} models found`, {
        description: baseUrl ? `From ${baseUrl}` : undefined,
      })
    } catch (e) {
      toast.error('Failed to fetch model list', {
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
        throw new Error(extractError(json?.error, 'Failed to save.'))
      }
      if (json.data) {
        setCfg(json.data)
        setApiKey('')
        setEmbeddingApiKey('')
      }
      toast.success('LLM configuration saved')
    } catch (e) {
      toast.error('Failed to save configuration', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <Tabs defaultValue="llm" className="min-h-[500px]">
        <TabsList className="w-max">
          <TabsTrigger value="llm" className="gap-1.5 text-xs">
            <Bot className="h-3.5 w-3.5" />
            LLM
          </TabsTrigger>
          <TabsTrigger value="embedding" className="gap-1.5 text-xs">
            <Server className="h-3.5 w-3.5" />
            Embedding
          </TabsTrigger>
        </TabsList>

        <TabsContent value="llm" className="mt-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-xs flex items-center gap-2">
                <Bot className="h-4 w-4" />
                LLM Configuration
              </CardTitle>
              <CardDescription className="text-xs">
                Connect an LLM provider. Choose OpenAI-Compatible or Anthropic-Compatible.
                Models are selected from a list fetched from the API endpoint.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* status row */}
              <div className="flex flex-wrap items-center gap-2">
                {cfg?.configured ? (
                  <Badge className="bg-success/15 text-success border-success/20">
                    <CheckCircle2 className="h-3 w-3" /> Configured
                  </Badge>
                ) : (
                  <Badge variant="secondary">Not configured</Badge>
                )}
                {cfg?.apiKeyMasked && (
                  <Badge variant="outline" className="font-mono text-xs">
                    <KeyRound className="h-3 w-3" /> {cfg.apiKeyMasked}
                  </Badge>
                )}
                {cfg?.lastModelSyncAt && (
                  <span className="text-xs text-muted-foreground">
                    Models synced {format(new Date(cfg.lastModelSyncAt), 'dd MMM yyyy, HH:mm')}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="llm-provider" className="text-xs">Provider</Label>
                  <Select value={provider} onValueChange={setProvider}>
                    <SelectTrigger id="llm-provider" className="text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OPENAI_COMPATIBLE">OpenAI-Compatible</SelectItem>
                      <SelectItem value="ANTHROPIC_COMPATIBLE">Anthropic-Compatible</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="llm-baseurl" className="text-xs">Base URL</Label>
                  <Input
                    id="llm-baseurl"
                    placeholder="https://api.openai.com/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="llm-apikey" className="text-xs">API Key</Label>
                  <div className="relative">
                    <Input
                      id="llm-apikey"
                      type="text"
                      placeholder={cfg?.apiKeyMasked ? `${cfg.apiKeyMasked}  (leave blank to keep)` : 'sk-...'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className={cn(
                        'pr-10 font-mono text-xs',
                        !showKey && 'text-security-disc',
                      )}
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showKey ? 'Hide' : 'Show'}
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5 md:col-span-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="llm-model" className="text-xs">Model</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      icon={syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      onClick={handleFetchModels}
                      disabled={syncing || !baseUrl}
                    >
                      Fetch Models
                    </Button>
                  </div>
                  {models.length > 0 ? (
                    <Select value={model} onValueChange={setModel}>
                      <SelectTrigger id="llm-model" className="text-xs">
                        <SelectValue placeholder="Select model" />
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
                      placeholder="gpt-4o-mini  (click 'Fetch Models' for list)"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="font-mono text-xs"
                    />
                  )}
                  {models.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Click <strong>Fetch Models</strong> to load the list from {baseUrl || 'base URL'}.
                    </p>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  onClick={handleSave}
                  disabled={saving || !baseUrl}
                >
                  Save Configuration
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="embedding" className="mt-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-xs flex items-center gap-2">
                <Server className="h-4 w-4" />
                RAG Embedding
              </CardTitle>
              <CardDescription className="text-xs">
                Used for hybrid retrieval. The endpoint uses the /embeddings format.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* status row */}
              <div className="flex flex-wrap items-center gap-2">
                {cfg?.embeddingApiKeyMasked ? (
                  <Badge className="bg-success/15 text-success border-success/20">
                    <CheckCircle2 className="h-3 w-3" /> Configured
                  </Badge>
                ) : (
                  <Badge variant="secondary">Not configured</Badge>
                )}
                {cfg?.embeddingApiKeyMasked && (
                  <Badge variant="outline" className="font-mono text-xs">
                    <KeyRound className="h-3 w-3" /> {cfg.embeddingApiKeyMasked}
                  </Badge>
                )}
                {cfg?.embeddingModel && (
                  <Badge variant="outline" className="text-xs">
                    {cfg.embeddingModel}
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="embedding-provider" className="text-xs">Embedding Provider</Label>
                  <Select
                    value={embeddingProvider}
                    onValueChange={setEmbeddingProvider}
                  >
                    <SelectTrigger id="embedding-provider" className="text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OPENAI_COMPATIBLE">OpenAI-Compatible</SelectItem>
                      <SelectItem value="ANTHROPIC_COMPATIBLE">Anthropic-Compatible</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="embedding-baseurl" className="text-xs">Embedding Base URL</Label>
                  <Input
                    id="embedding-baseurl"
                    placeholder="https://api.openai.com/v1"
                    value={embeddingBaseUrl}
                    onChange={(e) => setEmbeddingBaseUrl(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="embedding-model" className="text-xs">Embedding Model</Label>
                  <Input
                    id="embedding-model"
                    placeholder="text-embedding-3-small"
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="embedding-apikey" className="text-xs">Embedding API Key</Label>
                  <div className="relative">
                    <Input
                      id="embedding-apikey"
                      type="text"
                      placeholder={
                        cfg?.embeddingApiKeyMasked
                           ? `${cfg.embeddingApiKeyMasked}  (leave blank)`
                          : 'sk-...'
                      }
                      value={embeddingApiKey}
                      onChange={(e) => setEmbeddingApiKey(e.target.value)}
                      className={cn(
                        'pr-10 font-mono text-xs',
                        !showEmbeddingKey && 'text-security-disc',
                      )}
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={() => setShowEmbeddingKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showEmbeddingKey ? 'Hide' : 'Show'}
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

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  onClick={handleSave}
                  disabled={saving || !embeddingBaseUrl}
                >
                  Save Configuration
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
