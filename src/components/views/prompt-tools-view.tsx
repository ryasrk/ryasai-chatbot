'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Wrench,
  Database,
  Server,
  Save,
  Loader2,
  ShieldCheck,
  ExternalLink,
  FileText,
  AlertCircle,
  BookMarked,
  Plus,
  Trash2,
  Pencil,
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FormSkeleton, ListRowsSkeleton } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { extractError } from '@/lib/extract-error'

interface PromptSettings {
  systemPrompt: string
  tools: { rag: boolean; sql: boolean; restApi: boolean }
}

interface RestConnector {
  id: string
  name: string
  baseUrl: string
  isActive: boolean
  _count?: { endpoints?: number }
}

const DEFAULT_SETTINGS: PromptSettings = {
  systemPrompt: '',
  tools: { rag: true, sql: true, restApi: true },
}

const TOOL_ROWS: {
  key: keyof PromptSettings['tools']
  label: string
  desc: string
}[] = [
  { key: 'rag', label: 'Knowledge / RAG', desc: 'Find answers from uploaded documents.' },
  { key: 'sql', label: 'SQL (read-only)', desc: 'Query connected databases with a read-only guardrail.' },
  { key: 'restApi', label: 'REST API', desc: 'Call whitelisted REST endpoints.' },
]

/**
 * Prompt & Tools view — system prompt override and tool routing toggles,
 * plus a read-only summary of the SQL guardrail and REST endpoint whitelist.
 */
export function PromptToolsView() {
  const [settings, setSettings] = useState<PromptSettings>(DEFAULT_SETTINGS)
  const [connectors, setConnectors] = useState<RestConnector[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const load = useCallback(async () => {
    try {
      const [settingsRes, connectorsRes] = await Promise.all([
        fetch('/api/prompt-tools', { cache: 'no-store' }),
        fetch('/api/data-sources/rest-connectors', { cache: 'no-store' }),
      ])
      if (settingsRes.ok) {
        const data = await settingsRes.json()
        if (data?.ok && data.settings) {
          setSettings(data.settings as PromptSettings)
        }
      }
      if (connectorsRes.ok) {
        const data = await connectorsRes.json()
        if (data?.ok && Array.isArray(data.items)) {
          setConnectors(data.items as RestConnector[])
        }
      }
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function updateTool(key: keyof PromptSettings['tools'], value: boolean) {
    setSettings((prev) => ({ ...prev, tools: { ...prev.tools, [key]: value } }))
    setDirty(true)
  }

  function updatePrompt(value: string) {
    setSettings((prev) => ({ ...prev, systemPrompt: value }))
    setDirty(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/prompt-tools', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(extractError(json?.error, 'Failed to save.'))
      }
      if (json.settings) setSettings(json.settings as PromptSettings)
      setDirty(false)
      toast.success('Prompt & tools settings saved')
    } catch (e) {
      toast.error('Failed to save settings', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return showSkeleton ? <FormSkeleton fields={4} /> : null
  }

  const totalEndpoints = connectors.reduce((sum, c) => sum + (c._count?.endpoints ?? 0), 0)

  return (
    <div className="space-y-3">
      {loadError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load configuration</AlertTitle>
          <AlertDescription>
            Settings could not be loaded. Saving may overwrite existing configuration. Reload the page to try again.
          </AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="prompt" className="min-h-[500px]">
        <TabsList className="w-max">
          <TabsTrigger value="prompt" className="gap-1.5 text-xs">
            <Wrench className="h-3.5 w-3.5" />
            Prompt &amp; Tools
          </TabsTrigger>
          <TabsTrigger value="guardrails" className="gap-1.5 text-xs">
            <ShieldCheck className="h-3.5 w-3.5" />
            Guardrails
          </TabsTrigger>
          <TabsTrigger value="library" className="gap-1.5 text-xs">
            <BookMarked className="h-3.5 w-3.5" />
            Library
          </TabsTrigger>
        </TabsList>

        <TabsContent value="prompt" className="mt-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-xs flex items-center gap-2">
                <Wrench className="h-4 w-4" />
                System Prompt &amp; Tools
              </CardTitle>
              <CardDescription className="text-xs">
                Configure the default system instructions and enable/disable tools used by the router.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="system-prompt" className="text-xs">System Prompt</Label>
                <Textarea
                  id="system-prompt"
                  placeholder="Example: Always answer in English, be concise, and cite sources."
                  value={settings.systemPrompt}
                  onChange={(e) => updatePrompt(e.target.value)}
                  rows={4}
                  className="resize-y text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  Sent as a system message before the user's question. Leave blank to use the model's default.
                </p>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium">Tool Routing</div>
                <div className="divide-y">
                  {TOOL_ROWS.map((row) => (
                    <div key={row.key} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                      <div className="pr-4">
                        <div className="text-xs font-medium">{row.label}</div>
                        <div className="text-xs text-muted-foreground">{row.desc}</div>
                      </div>
                      <Switch
                        checked={settings.tools[row.key]}
                        onCheckedChange={(v) => updateTool(row.key, v)}
                        aria-label={row.label}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={!dirty || saving || loadError} className="gap-1.5">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="guardrails" className="mt-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-xs flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                Guardrails &amp; Whitelist
              </CardTitle>
              <CardDescription className="text-xs">
                Summary of security rules that restrict tools. These settings are read-only — manage them in Data Sources.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <div className="text-xs font-medium flex items-center gap-2">
                  <Database className="h-4 w-4 text-muted-foreground" />
                  SQL Guardrail
                </div>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <ShieldCheck className="h-3.5 w-3.5 mt-0.5 text-success shrink-0" />
                    Only <code className="rounded bg-muted px-1 font-mono text-xs">SELECT</code> commands are allowed.
                  </li>
                  <li className="flex items-start gap-2">
                    <ShieldCheck className="h-3.5 w-3.5 mt-0.5 text-success shrink-0" />
                    DML/DDL is blocked.
                  </li>
                  <li className="flex items-start gap-2">
                    <ShieldCheck className="h-3.5 w-3.5 mt-0.5 text-success shrink-0" />
                    Database connections only access whitelisted schemas/tables.
                  </li>
                </ul>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium flex items-center gap-2">
                    <Server className="h-4 w-4 text-muted-foreground" />
                    REST Endpoint Whitelist
                  </div>
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new CustomEvent('navigate-view', { detail: { view: 'integrations' } }))}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Manage <ExternalLink className="h-3 w-3" />
                  </button>
                </div>
                {connectors.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    <FileText className="h-4 w-4" />
                    No REST connectors yet. Add them from Data Sources.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {connectors.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between rounded-md border bg-background px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-medium truncate">{c.name}</div>
                          <div className="text-xs text-muted-foreground font-mono truncate">{c.baseUrl}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="outline" className="text-xs">
                            {c._count?.endpoints ?? 0} endpoint
                          </Badge>
                          {c.isActive ? (
                            <Badge className="bg-success/15 text-success text-xs">
                              Active
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">
                              Inactive
                            </Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {totalEndpoints > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Total {totalEndpoints} endpoints registered in the whitelist.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="library" className="mt-3">
          <PromptLibrary />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ============================================================ prompt library */

interface SavedPrompt {
  id: string
  title: string
  content: string
  category?: string | null
  isPublic: boolean
  updatedAt: string
}

function PromptLibrary() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [editing, setEditing] = useState<SavedPrompt | null>(null)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/prompts', { cache: 'no-store' })
      const j = await res.json()
      if (res.ok && Array.isArray(j.prompts)) setPrompts(j.prompts as SavedPrompt[])
    } catch { toast.error('Failed to load prompts.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSave = async (data: { title: string; content: string; category?: string; isPublic?: boolean }) => {
    if (editing) {
      const res = await fetch(`/api/prompts/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (res.ok) { toast.success('Prompt updated'); setShowForm(false); setEditing(null); load() }
      else { const j = await res.json().catch(() => ({})); toast.error(extractError(j.error, 'Failed to update.')) }
    } else {
      const res = await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (res.ok) { toast.success('Prompt created'); setShowForm(false); load() }
      else { const j = await res.json().catch(() => ({})); toast.error(extractError(j.error, 'Failed to create.')) }
    }
  }

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/prompts/${id}`, { method: 'DELETE' })
    if (res.ok) { toast.success('Prompt deleted'); load() }
    else { toast.error('Failed to delete.') }
  }

  if (loading) return showSkeleton ? <ListRowsSkeleton count={3} /> : null

  if (showForm) {
    return (
      <PromptForm
        initial={editing}
        onSave={handleSave}
        onCancel={() => { setShowForm(false); setEditing(null) }}
      />
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-xs flex items-center gap-2">
              <BookMarked className="h-4 w-4" />
              Prompt Library
            </CardTitle>
            <CardDescription className="text-xs">
              Save and reuse prompt templates across sessions.
            </CardDescription>
          </div>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => { setEditing(null); setShowForm(true) }} className="gap-1.5">
            New
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {prompts.length === 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-xs text-muted-foreground">
            <FileText className="h-4 w-4" />
            No saved prompts yet. Click &ldquo;New&rdquo; to create one.
          </div>
        ) : (
          <div className="space-y-1.5">
            {prompts.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                <div className="min-w-0 flex-1 pr-2">
                  <div className="text-xs font-medium truncate">{p.title}</div>
                  <div className="text-xs text-muted-foreground truncate font-mono">
                    {p.content.slice(0, 80)}{p.content.length > 80 ? '…' : ''}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    {p.category && <Badge variant="secondary" className="text-xs">{p.category}</Badge>}
                    {p.isPublic && <Badge className="text-xs bg-primary/10 text-primary">Public</Badge>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditing(p); setShowForm(true) }}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 hover:bg-destructive/10 hover:text-destructive" onClick={() => handleDelete(p.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function PromptForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: SavedPrompt | null
  onSave: (data: { title: string; content: string; category?: string; isPublic?: boolean }) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [category, setCategory] = useState(initial?.category ?? '')
  const [isPublic, setIsPublic] = useState(initial?.isPublic ?? false)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs">{initial ? 'Edit Prompt' : 'New Prompt'}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label className="text-xs">Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. SQL Expert" className="text-xs" />
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Content</Label>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Prompt template text…"
            rows={6}
            className="resize-y text-xs"
          />
        </div>
        <div className="flex items-center gap-4">
          <div className="flex-1 space-y-2">
            <Label className="text-xs">Category (optional)</Label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. sql, rag, general" className="text-xs" />
          </div>
          <div className="flex items-center gap-2 pt-5">
            <Switch checked={isPublic} onCheckedChange={setIsPublic} />
            <Label className="text-xs">Public</Label>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" icon={<Save className="h-3.5 w-3.5" />} disabled={!title.trim() || !content.trim()} onClick={() => onSave({ title: title.trim(), content: content.trim(), category: category.trim() || undefined, isPublic })}>
            {initial ? 'Update' : 'Create'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
