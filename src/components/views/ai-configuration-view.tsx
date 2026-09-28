'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  Brain,
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
import { handleSessionFailure } from '@/lib/session-guard'
import { CogneeCard } from '@/components/views/cognee-card'

/**
 * Build the PUT body for a model change.
 *
 * WHY A MODEL CHANGE MUST SEND MORE THAN THE MODEL — MEASURED, not assumed.
 *
 * `PUT /api/llm-config` is a whole-row upsert whose every field has a DEFAULT, and
 * `normalizeBaseUrl('')` returns `''` rather than throwing. So `{ model: 'x' }` does not mean "change
 * only the model"; it means "set provider to OPENAI_COMPATIBLE, baseUrl to '', embeddingProvider to
 * OPENAI_COMPATIBLE, embeddingBaseUrl to '', embeddingModel to the built-in default, and the model to
 * x". Probed against the real route on a row configured as
 * `{provider: 'ANTHROPIC_COMPATIBLE', baseUrl: 'https://real.example.com/v1', embeddingModel: 'bge-m3'}`:
 *
 *   { model: 'new-model' }  ->  {"provider":"OPENAI_COMPATIBLE","baseUrl":"","model":"new-model",
 *                                "embeddingProvider":"OPENAI_COMPATIBLE","embeddingBaseUrl":"",
 *                                "embeddingModel":"text-embedding-3-small"}
 *
 * That is a working BYOK install reduced to an unreachable one, by picking a model from the dropdown —
 * the very action this view exists to make safe. And the response is applied only to `cfg`, not to the
 * `baseUrl` form field, so the screen keeps SHOWING the old URL while the database holds an empty one:
 * navigate away and back and the URL is gone, which is the reported symptom's shape in a second field.
 *
 * The values are read from the SERVER's own view of the row (`cfg`), not from the editable form state,
 * so a half-typed Base URL in the input cannot be smuggled into storage by a model pick. The two key
 * fields are omitted on purpose: omitted means "keep the stored key" (the route only re-encrypts when
 * a non-empty `apiKey` is sent), so a model pick can never rotate or clear a credential.
 */
export function modelPatchPayload(
  cfg: PublicLlmConfig | null,
  next: string,
): Record<string, string> {
  const body: Record<string, string> = { model: next }
  if (!cfg) return body
  body.provider = cfg.provider
  body.baseUrl = cfg.baseUrl
  body.embeddingProvider = cfg.embeddingProvider
  body.embeddingBaseUrl = cfg.embeddingBaseUrl
  body.embeddingModel = cfg.embeddingModel
  return body
}

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
  /**
   * True when a model was CHOSEN but its write failed, so the control shows a value the server does not
   * have yet.
   *
   * Reproduced defect: choose a model, navigate away, come back — the selection was gone, with nothing
   * having said it was unsaved. The value was never lost by the app; it was never SENT, and the screen
   * gave no sign of that. The picker now writes immediately, and this flag exists for the one case that
   * can still leave the two out of step: a write that failed.
   */
  const [modelUnsaved, setModelUnsaved] = useState(false)
  /**
   * The message for the last FAILED model write, or null.
   *
   * A separate string from the boolean, because the boolean is also set while a write is merely in
   * flight (it means "the control is ahead of the server") whereas the message must only appear for a
   * write that genuinely failed. Rendering a permanent failure sentence during every normal, successful
   * save was the first version of this banner, and it was a lie the user had no way to check.
   */
  const [modelSaveFailed, setModelSaveFailed] = useState<string | null>(null)
  /**
   * The value to rescue if this view unmounts mid-edit, and whether a write is still owed.
   *
   * WHY A REF AND AN UNMOUNT EFFECT, rather than relying on blur: on the free-text path a user can type
   * a model and switch menus WITHOUT ever blurring the field — clicking the sidebar does not necessarily
   * fire blur before the view unmounts. The typed value then died with the component, which is the same
   * reported symptom through the other input.
   *
   * A fetch started during unmount still completes: switching views is a client-side route change, not a
   * page unload, so the request is not cancelled. `navigator.sendBeacon` would be needed only for a real
   * unload, which is a different case and not what was reported.
   */
  const pendingModelRef = useRef<{ value: string; owed: boolean }>({ value: '', owed: false })
  /**
   * The last config the SERVER told us about, for the unmount rescue below.
   *
   * The cleanup closure cannot read `cfg` directly — it captures the value from the render it was
   * created in, which is the FIRST one. A ref updated by an effect always holds the current value.
   */
  const cfgRef = useRef<PublicLlmConfig | null>(null)
  /**
   * Ordering for model writes.
   *
   * A statement number: only the newest write may apply its response. Without it, two commits were two
   * concurrent whole-row PUTs, and the slower one — the model the user had already moved OFF — could
   * land last and become the stored value while the control displayed the newer one.
   */
  const modelWriteSeq = useRef(0)
  /**
   * The value of the model write currently on the wire, if any.
   *
   * Used by the unmount cleanup to tell "a write for this value is already running" from "this value
   * has never been sent" — the first needs no rescue (the in-flight request completes on a client-side
   * navigation), the second does.
   */
  const inFlightValueRef = useRef<string | null>(null)
  useEffect(() => {
    cfgRef.current = cfg
  }, [cfg])
  useEffect(() => {
    return () => {
      const pending = pendingModelRef.current
      if (!pending.owed || !pending.value.trim()) return
      /*
       * Adopt an in-flight write instead of racing it.
       *
       * If `persistModel` already started for this exact value, the write is on its way and a second
       * PUT from here would duplicate it. The sequence is bumped so the departing component's own
       * response handler is superseded (it has nothing left to set), and the request keeps its own
       * promise — switching views is a client-side route change, so it still completes and still
       * persists the value. That rescue path is what the unmount effect exists for; this covers the
       * narrower case where the write had ALREADY begun when the user navigated away.
       */
      if (inFlightValueRef.current === pending.value.trim()) return
      // Fire and forget: the component is going away, so nothing can await this.
      void fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // The SAME complete payload the interactive path sends. A bare `{ model }` here does not mean
        // "change only the model" — see `modelPatchPayload`; it resets every other field, silently,
        // from a cleanup that no one can see the result of.
        body: JSON.stringify(modelPatchPayload(cfgRef.current, pending.value.trim())),
      }).catch(() => null)
    }
  }, [])
  // Controlled so an external navigation can land on a specific tab (e.g. the dashboard's AI
  // Memory card opening the `memory` tab). An uncontrolled `defaultValue` would ignore the target.
  const [tab, setTab] = useState('llm')

  /**
   * Accept a tab selected from outside.
   *
   * Two ways in, both used by callers that already exist: the `navigate-view` event (the sidebar
   * and topbar dispatch it) and a `?tab=` query parameter for links that survive a reload.
   */
  useEffect(() => {
    const applyTab = (raw: string | null | undefined) => {
      if (raw === 'llm' || raw === 'embedding' || raw === 'memory') setTab(raw)
    }
    applyTab(new URLSearchParams(window.location.search).get('tab'))
    const onNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail as { view?: string; tab?: string } | undefined
      if (detail?.view === 'ai-config') applyTab(detail.tab)
    }
    window.addEventListener('navigate-view', onNavigate as EventListener)
    return () => window.removeEventListener('navigate-view', onNavigate as EventListener)
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/llm-config', { cache: 'no-store' })
      .then(async (r) => {
        /*
         * A DEAD SESSION MUST NOT RENDER AS AN EMPTY FORM.
         *
         * MEASURED IN UAT: with an expired session this returns 401, `llm?.ok` is falsy, `setCfg` is never called,
         * and the form below renders from UNSET state — an empty model field, no message, and a header that still
         * shows a logged-in user. A real user reported exactly this as "the model I picked disappeared". Surfacing
         * it makes the shell show the login screen, which is the truthful explanation.
         */
        if (await handleSessionFailure(r)) return null
        return r.json()
      })
      .then((llm) => {
        if (cancelled) return
        if (!llm) return // a session failure was recorded by the guard above
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

  /**
   * Persist the model the moment it is picked.
   *
   * WHY IMMEDIATELY rather than on Save: choosing from a dropdown is a COMPLETE intent, not a
   * half-finished form. Requiring Save afterwards is what made the choice silently die on navigation —
   * the reported bug — and it left no way for a user to tell which fields were staged and which were
   * committed.
   *
   * ONLY `model` IS SENT. A full-object PUT would resend `baseUrl`, `embeddingModel` and the key fields
   * from local state, so a stale value for any of them would overwrite a good one. Choosing a model must
   * not be able to corrupt the rest of the form.
   */

  async function persistModel(next: string) {
    setModel(next)
    setModelUnsaved(true)
    // Cleared as the attempt begins: the destructive message below must only ever describe a write
    // that has actually failed, never one that is merely still open. Leaving the previous failure's
    // text on screen during a retry would report the old outcome as the new one's.
    setModelSaveFailed(null)
    pendingModelRef.current = { value: next, owed: true }
    /*
     * Order model writes by INTENT, not by arrival.
     *
     * `modelWriteSeq` is a statement number: only the newest write may apply its response. Without it,
     * two commits were two concurrent whole-row PUTs, and the slower one — the model the user had
     * already moved OFF — could land last and become the stored value while the control displayed the
     * newer one. The sequence makes the last click the winner, which is what the user sees.
     */
    const write = ++modelWriteSeq.current
    inFlightValueRef.current = next
    try {
      const res = await fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelPatchPayload(cfgRef.current, next)),
      })
      const json = await res.json().catch(() => null)
      // A superseded write must not touch state at all — not the flag, not the toast, not `cfg`.
      if (write !== modelWriteSeq.current) return
      if (!res.ok || !json?.ok) {
        throw new Error(extractError(json?.error, 'Could not save the model.'))
      }
      inFlightValueRef.current = null
      setModelUnsaved(false)
      pendingModelRef.current = { value: '', owed: false }
      if (json.data) setCfg(json.data)
      toast.success('Model saved', { description: next })
    } catch (e) {
      // The selection STAYS in the control and the unsaved flag stays set, so a failed write is never
      // presented as a successful one.
      if (write !== modelWriteSeq.current) return
      inFlightValueRef.current = null
      setModelSaveFailed(e instanceof Error ? e.message : 'Could not save the model.')
      toast.error('Could not save the model', {
        description: e instanceof Error ? e.message : undefined,
      })
    }
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
      /*
       * Reconcile: if the current model is not in the fresh list, snap to the first — and PERSIST it.
       *
       * This used to be a bare `setModel(list[0])`, which is the original reported defect exactly:
       * local state changed, nothing was written, so the selection reverted the moment the user left
       * the view. A model the provider does not serve is not merely unsaved, it cannot work, so
       * leaving the row pointing at it is worse than the empty selection it looks like on a revisit.
       */
      if (list.length > 0 && !list.includes(model) && list[0]) {
        void persistModel(list[0])
      }
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
      // This write covers every field the model pick could have left outstanding, so the "not saved
      // yet" warning is now false and must go. Leaving it up after a successful Save would tell the
      // user their model is still unsaved while the row holds it.
      setModelUnsaved(false)
      setModelSaveFailed(null)
      pendingModelRef.current = { value: '', owed: false }
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
      <Tabs value={tab} onValueChange={setTab} className="min-h-[500px]">
        <TabsList className="w-max">
          <TabsTrigger value="llm" className="gap-1.5 text-xs">
            <Bot className="h-3.5 w-3.5" />
            LLM
          </TabsTrigger>
          <TabsTrigger value="embedding" className="gap-1.5 text-xs">
            <Server className="h-3.5 w-3.5" />
            Embedding
          </TabsTrigger>
          {/*
            AI Memory lives here as well as under Knowledge.

            WHY BOTH: this view is where an admin already goes to configure the model and embedding
            endpoint, and memory needs its OWN model credentials — so the tab that explains that
            belongs beside the two settings it is adjacent to. Knowledge keeps its tab because that
            is where the memory's EFFECT is visible (documents, graph, cognify status). Neither is a
            duplicate link: they show the same card for two different tasks.
          */}
          <TabsTrigger value="memory" className="gap-1.5 text-xs">
            <Brain className="h-3.5 w-3.5" />
            AI Memory
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
                    <Select value={model} onValueChange={(v) => void persistModel(v)}>
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
                      onChange={(e) => {
                        setModel(e.target.value)
                        // Recorded as OWED but not yet written: reading the value from local state in the
                        // unmount cleanup would read a stale closure, so the ref is the source of truth.
                        pendingModelRef.current = { value: e.target.value, owed: true }
                      }}
                      /*
                       * Committed on BLUR, not per keystroke: a PUT per character would persist
                       * half-typed model names, and a partial name is a real value the runtime would
                       * then try to call. Blur is the point at which the text is the user's answer.
                       */
                      onBlur={(e) => {
                        const next = e.target.value.trim()
                        if (next && next !== cfg?.model) void persistModel(next)
                      }}
                      className="font-mono text-xs"
                    />
                  )}
                  {modelSaveFailed !== null && (
                    /*
                     * Shown only when a write FAILED, and showing WHY. Silence would leave the control
                     * displaying a value the server does not have.
                     *
                     * `role="status"` + `aria-live="polite"`: this paragraph APPEARS in response to an
                     * action, and a newly-inserted element is not announced by a screen reader on its
                     * own — the user who picked a model and got a failure would otherwise be told
                     * nothing at all, which is precisely the "it silently did not save" complaint.
                     */
                    <p className="text-xs text-destructive" role="status" aria-live="polite">
                      This model is not saved yet — {modelSaveFailed} Press Save, or choose again.
                    </p>
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
                  size="sm"
                  className="h-7 text-xs"
                  icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
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
                  size="sm"
                  className="h-7 text-xs"
                  icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  onClick={handleSave}
                  disabled={saving || !embeddingBaseUrl}
                >
                  Save Configuration
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="memory" className="mt-2">
          <CogneeCard />
        </TabsContent>
      </Tabs>
    </div>
  )
}
