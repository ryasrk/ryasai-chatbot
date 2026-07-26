'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Puzzle,
  Search,
  Plus,
  Trash2,
  Pencil,
  Play,
  Globe,
  Lock,
  Zap,
  Database,
  Activity,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Check,
  Server,
  Store,
  MessageSquare,
  Bot,
  ExternalLink,
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginManifestShape {
  paramDescription: string
  executorType: string
  endpoint: string
  method: string
  authType: string
  authCredentials?: string
  timeoutMs: number
  description: string
}

interface PluginRow {
  id: string
  toolId: string
  name: string
  description: string
  manifest: PluginManifestShape | null
  isEnabled: boolean
  chatEnabled: boolean
  agenticEnabled: boolean
  category?: string
  subcategory?: string
  keywords?: string
  createdAt: string
  updatedAt: string
}

interface McpServerRow {
  id: string
  name: string
  description: string
  transport: string
  command: string
  args: string
  url: string
  hasEnvVars: boolean
  isEnabled: boolean
  chatEnabled: boolean
  agenticEnabled: boolean
  createdAt: string
  updatedAt: string
}

interface McpCatalogEntry {
  name: string
  description: string
  category: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  installInstructions: string
  repoUrl: string
}

interface TestResult {
  ok: boolean
  output: string
  error?: string
  latencyMs: number
}

// ---------------------------------------------------------------------------
// Main view — 3 tabs
// ---------------------------------------------------------------------------

export function PluginsView() {
  const [tab, setTab] = useState('browse')

  useEffect(() => {
    function onSwitch(e: Event) {
      const detail = (e as CustomEvent<string>).detail
      setTab(detail ?? 'mcp')
    }
    window.addEventListener('mcp-switch-tab', onSwitch)
    return () => window.removeEventListener('mcp-switch-tab', onSwitch)
  }, [])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <Puzzle className="h-4 w-4 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-semibold">Tools &amp; Integrations</h2>
          <p className="text-xs text-muted-foreground">
            MCP servers, custom webhook tools, and marketplace browsing.
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="min-h-[500px]">
        <TabsList className="w-max">
          <TabsTrigger value="browse" className="gap-1.5 text-xs">
            <Store className="h-3.5 w-3.5" /> Browse MCP
          </TabsTrigger>
          <TabsTrigger value="mcp" className="gap-1.5 text-xs">
            <Server className="h-3.5 w-3.5" /> MCP Servers
          </TabsTrigger>
          <TabsTrigger value="custom" className="gap-1.5 text-xs">
            <Puzzle className="h-3.5 w-3.5" /> Custom Tools
          </TabsTrigger>
        </TabsList>

        <TabsContent value="browse" className="mt-3">
          <BrowseMcpTab />
        </TabsContent>
        <TabsContent value="mcp" className="mt-3">
          <McpServersTab />
        </TabsContent>
        <TabsContent value="custom" className="mt-3">
          <CustomToolsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toggle popup — reusable Chatbot/Agentic enable popover
// ---------------------------------------------------------------------------

function TogglePopup({
  isEnabled,
  chatEnabled,
  agenticEnabled,
  disabled,
  onToggle,
  onContextChange,
}: {
  isEnabled: boolean
  chatEnabled: boolean
  agenticEnabled: boolean
  disabled?: boolean
  onToggle: () => void
  onContextChange: (chat: boolean, agentic: boolean) => void
}) {
  // ponytail: no local state — props are the source of truth. Parent updates
  // via onContextChange and the new values flow back. Avoids setState-in-effect.
  return (
    <div className="flex items-center gap-1.5">
      <Switch checked={isEnabled} onCheckedChange={onToggle} disabled={disabled} />
      {isEnabled && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="rounded-md border border-border/60 p-1 text-muted-foreground hover:bg-muted transition-colors"
              title="Configure usage scope"
              disabled={disabled}
            >
              <ChevronRight className="h-3 w-3 rotate-90" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-3">
            <div className="space-y-2">
              <p className="text-xs font-medium">Use in</p>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={chatEnabled}
                  onCheckedChange={(v) => onContextChange(v === true, agenticEnabled)}
                />
                <span className="text-xs flex items-center gap-1.5">
                  <MessageSquare className="h-3 w-3" /> Chatbot
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={agenticEnabled}
                  onCheckedChange={(v) => onContextChange(chatEnabled, v === true)}
                />
                <span className="text-xs flex items-center gap-1.5">
                  <Bot className="h-3 w-3" /> Agentic
                </span>
              </label>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 1 — Browse MCP marketplace catalog
// ---------------------------------------------------------------------------

function BrowseMcpTab() {
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('all')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/mcp/catalog')
        const data = await res.json()
        if (cancelled) return
        if (data.ok) {
          setCatalog(data.catalog)
          setCategories(data.categories)
        }
      } catch {
        // ponytail: static catalog, network failure is non-fatal
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return catalog.filter((e) => {
      if (catFilter !== 'all' && e.category !== catFilter) return false
      if (!q) return true
      return [e.name, e.description, e.category].join(' ').toLowerCase().includes(q)
    })
  }, [catalog, search, catFilter])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search MCP servers…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="h-8 w-full text-xs sm:w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">All Categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((entry) => (
          <Card key={entry.name} className="rounded-lg border p-4 flex flex-col gap-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{entry.name}</p>
                <Badge variant="secondary" className="text-xs mt-0.5">{entry.category}</Badge>
              </div>
              <Badge className="text-xs bg-primary/15 text-primary border-primary/20 shrink-0 uppercase">
                {entry.transport}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2.5rem]">
              {entry.description}
            </p>
            <code className="font-mono text-xs text-muted-foreground truncate block">
              {entry.installInstructions}
            </code>
            <div className="flex items-center gap-1 pt-1 border-t border-border/40 mt-auto">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => {
                  // ponytail: dispatch two events — switch tab + pre-fill dialog.
                  // Simpler than shared state lifting across sibling tabs.
                  window.dispatchEvent(new CustomEvent('mcp-switch-tab', { detail: 'mcp' }))
                  window.dispatchEvent(new CustomEvent('mcp-add-from-catalog', { detail: entry }))
                }}
              >
                <Plus className="h-3 w-3" /> Add
              </Button>
              <a
                href={entry.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                Repo <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </Card>
        ))}
      </div>

      {filtered.length === 0 && (
        <Card className="rounded-lg border">
          <CardContent className="py-16 flex flex-col items-center justify-center gap-3">
            <Store className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No matching MCP servers</p>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Click <span className="font-medium">Add</span> to pre-fill the MCP server form in the MCP Servers tab.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs gap-1.5"
        onClick={() => {
          window.dispatchEvent(new CustomEvent('mcp-switch-tab', { detail: 'mcp' }))
        }}
      >
        Skip — configure manually <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 2 — MCP Servers (configured instances)
// ---------------------------------------------------------------------------

const EMPTY_MCP_FORM = {
  name: '',
  description: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  envVars: '',
}

function McpServersTab() {
  const [servers, setServers] = useState<McpServerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<McpServerRow | null>(null)
  const [form, setForm] = useState({ ...EMPTY_MCP_FORM })
  const [saving, setSaving] = useState(false)

  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const fetchServers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/mcp/servers')
      const data = await res.json()
      if (data.ok) setServers(data.servers)
    } catch {
      toast.error('Failed to load MCP servers.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  // ponytail: listen for catalog "Add" events from BrowseMcpTab. Parent
  // handles the tab switch; we just open the dialog pre-filled.
  useEffect(() => {
    function onAddFromCatalog(e: Event) {
      const entry = (e as CustomEvent<McpCatalogEntry>).detail
      setEditing(null)
      setForm({
        name: entry.name,
        description: entry.description,
        transport: entry.transport,
        command: entry.command ?? '',
        args: entry.args ? entry.args.join('\n') : '',
        url: entry.url ?? '',
        envVars: '',
      })
      setDialogOpen(true)
    }
    window.addEventListener('mcp-add-from-catalog', onAddFromCatalog)
    return () => window.removeEventListener('mcp-add-from-catalog', onAddFromCatalog)
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return servers
    return servers.filter((s) =>
      [s.name, s.description, s.transport, s.command, s.url].join(' ').toLowerCase().includes(q),
    )
  }, [servers, search])

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY_MCP_FORM })
    setDialogOpen(true)
  }

  function openEdit(s: McpServerRow) {
    setEditing(s)
    let argsStr = ''
    try {
      const parsed = JSON.parse(s.args)
      argsStr = Array.isArray(parsed) ? parsed.join('\n') : ''
    } catch { argsStr = '' }
    setForm({
      name: s.name,
      description: s.description,
      transport: s.transport,
      command: s.command,
      args: argsStr,
      url: s.url,
      envVars: '',
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast.error('Name is required.')
      return
    }
    if (form.transport === 'stdio' && !form.command.trim()) {
      toast.error('Command is required for stdio transport.')
      return
    }
    if (form.transport !== 'stdio' && !form.url.trim()) {
      toast.error('URL is required for sse/http transport.')
      return
    }

    setSaving(true)
    try {
      const argsArr = form.args.split('\n').map((a) => a.trim()).filter(Boolean)
      const envVars: Record<string, string> = {}
      if (form.envVars.trim()) {
        for (const line of form.envVars.split('\n')) {
          const idx = line.indexOf('=')
          if (idx > 0) {
            envVars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
          }
        }
      }

      const body: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim(),
        transport: form.transport,
        command: form.command.trim(),
        args: argsArr,
        url: form.url.trim(),
        envVars,
      }

      const isEdit = editing !== null
      const url = isEdit ? `/api/mcp/servers/${editing!.id}` : '/api/mcp/servers'
      const method = isEdit ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success(isEdit ? 'MCP server updated.' : 'MCP server added.')
        setDialogOpen(false)
        fetchServers()
      } else {
        toast.error(data.error || 'Failed to save MCP server.')
      }
    } catch {
      toast.error('Failed to save MCP server.')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(s: McpServerRow) {
    setTogglingId(s.id)
    try {
      const res = await fetch(`/api/mcp/servers/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: !s.isEnabled }),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success(s.isEnabled ? 'MCP server disabled.' : 'MCP server enabled.')
        fetchServers()
      } else {
        toast.error(data.error || 'Failed to toggle.')
      }
    } catch {
      toast.error('Failed to toggle.')
    } finally {
      setTogglingId(null)
    }
  }

  async function handleContextChange(s: McpServerRow, chat: boolean, agentic: boolean) {
    try {
      const res = await fetch(`/api/mcp/servers/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatEnabled: chat, agenticEnabled: agentic }),
      })
      const data = await res.json()
      if (data.ok) {
        fetchServers()
      } else {
        toast.error(data.error || 'Failed to update scope.')
      }
    } catch {
      toast.error('Failed to update scope.')
    }
  }

  async function handleDelete() {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/mcp/servers/${deleteId}`, { method: 'DELETE' })
      const data = await res.json()
      if (data.ok) {
        toast.success('MCP server deleted.')
        setDeleteId(null)
        fetchServers()
      } else {
        toast.error(data.error || 'Failed to delete.')
      }
    } catch {
      toast.error('Failed to delete.')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search MCP servers…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Button size="sm" onClick={openCreate} className="h-7 text-xs gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add Server
        </Button>
      </div>

      {filtered.length === 0 ? (
        <Card className="rounded-lg border">
          <CardContent className="py-16 flex flex-col items-center justify-center gap-3">
            <Server className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {servers.length === 0 ? 'No MCP servers configured' : 'No matching servers'}
            </p>
            <Button size="sm" onClick={openCreate} className="h-7 text-xs gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add MCP Server
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => (
            <Card key={s.id} className="rounded-lg border p-4 flex flex-col gap-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 shrink-0">
                    <Server className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{s.name}</p>
                    <Badge className="text-xs bg-primary/15 text-primary border-primary/20 uppercase shrink-0">
                      {s.transport}
                    </Badge>
                  </div>
                </div>
                <TogglePopup
                  isEnabled={s.isEnabled}
                  chatEnabled={s.chatEnabled}
                  agenticEnabled={s.agenticEnabled}
                  disabled={togglingId === s.id}
                  onToggle={() => handleToggle(s)}
                  onContextChange={(chat, agentic) => handleContextChange(s, chat, agentic)}
                />
              </div>

              <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2.5rem]">
                {s.description || 'No description'}
              </p>

              {s.transport === 'stdio' ? (
                <code className="font-mono text-xs text-muted-foreground truncate block">
                  {s.command} {s.args}
                </code>
              ) : (
                <code className="font-mono text-xs text-muted-foreground truncate block">
                  {s.url}
                </code>
              )}

              <div className="flex items-center gap-1 pt-1 border-t border-border/40 mt-auto">
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => openEdit(s)}>
                  <Pencil className="h-3 w-3" /> Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
                  onClick={() => setDeleteId(s.id)}
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add/Edit MCP server dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) setDialogOpen(false) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {editing ? 'Edit MCP Server' : 'Add MCP Server'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {editing ? 'Update MCP server configuration.' : 'Connect a new MCP server (stdio, sse, or http).'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Filesystem"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Description</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Read/write files on the local filesystem"
                className="h-8 text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Transport</Label>
                <Select value={form.transport} onValueChange={(v) => setForm({ ...form, transport: v })}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio" className="text-xs">stdio</SelectItem>
                    <SelectItem value="sse" className="text-xs">sse</SelectItem>
                    <SelectItem value="http" className="text-xs">http</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.transport === 'stdio' ? (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Command</Label>
                  <Input
                    value={form.command}
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                    placeholder="npx"
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Args (one per line)</Label>
                  <Textarea
                    value={form.args}
                    onChange={(e) => setForm({ ...form, args: e.target.value })}
                    placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'}
                    className="text-xs font-mono min-h-[64px]"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs">URL</Label>
                <Input
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://mcp-server.example.com/sse"
                  className="h-8 text-xs font-mono"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Env Vars (KEY=value, one per line)</Label>
              <Textarea
                value={form.envVars}
                onChange={(e) => setForm({ ...form, envVars: e.target.value })}
                placeholder={'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx\nBRAVE_API_KEY=BSAxxx'}
                className="text-xs font-mono min-h-[56px]"
              />
              <p className="text-xs text-muted-foreground">
                {editing?.hasEnvVars ? 'Leave blank to keep existing env vars.' : 'Encrypted at rest (AES-256-GCM).'}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              className="h-7 text-xs gap-1.5"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null) }}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete MCP Server?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              This action cannot be undone. The MCP server will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-7 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="h-7 text-xs bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 3 — Custom Tools (existing webhook plugins)
// ---------------------------------------------------------------------------

const PREDEFINED_CATEGORIES = [
  'general',
  'database',
  'api',
  'monitoring',
  'security',
  'productivity',
]

const CATEGORY_ICONS: Record<string, typeof Puzzle> = {
  general: Puzzle,
  database: Database,
  api: Globe,
  monitoring: Activity,
  security: Lock,
  productivity: Zap,
}

function iconForCategory(cat: string | undefined) {
  return CATEGORY_ICONS[cat ?? 'general'] ?? Puzzle
}

const EMPTY_FORM = {
  toolId: '',
  name: '',
  description: '',
  category: 'general',
  keywords: '',
  endpoint: '',
  method: 'POST',
  timeoutMs: 15000,
  authType: 'NONE',
  authCredentials: '',
  testInput: '',
}

function CustomToolsTab() {
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all')

  const [wizardOpen, setWizardOpen] = useState(false)
  const [editing, setEditing] = useState<PluginRow | null>(null)
  const [step, setStep] = useState(1)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [testingInWizard, setTestingInWizard] = useState(false)
  const [wizardTestResult, setWizardTestResult] = useState<TestResult | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)

  const [testPlugin, setTestPlugin] = useState<PluginRow | null>(null)
  const [testInput, setTestInput] = useState('')
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const categories = useMemo(() => {
    const dataCats = plugins.map((p) => p.category).filter(Boolean) as string[]
    return ['all', ...Array.from(new Set([...PREDEFINED_CATEGORIES, ...dataCats]))]
  }, [plugins])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return plugins.filter((p) => {
      if (catFilter !== 'all' && p.category !== catFilter) return false
      if (statusFilter === 'enabled' && !p.isEnabled) return false
      if (statusFilter === 'disabled' && p.isEnabled) return false
      if (!q) return true
      const hay = [p.name, p.description, p.toolId, p.keywords, p.category, p.manifest?.endpoint]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [plugins, search, catFilter, statusFilter])

  const fetchPlugins = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/tools')
      const data = await res.json()
      if (data.ok) {
        setPlugins(data.plugins)
      } else {
        toast.error(data.error || 'Failed to load tools.')
      }
    } catch {
      toast.error('Failed to load tools.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPlugins()
  }, [fetchPlugins])

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY_FORM })
    setStep(1)
    setWizardTestResult(null)
    setCreatedId(null)
    setWizardOpen(true)
  }

  function openEdit(p: PluginRow) {
    setEditing(p)
    setForm({
      toolId: p.toolId,
      name: p.name,
      description: p.description,
      category: p.category || 'general',
      keywords: p.keywords || '',
      endpoint: p.manifest?.endpoint || '',
      method: p.manifest?.method || 'POST',
      timeoutMs: p.manifest?.timeoutMs || 15000,
      authType: p.manifest?.authType || 'NONE',
      authCredentials: '',
      testInput: '',
    })
    setStep(1)
    setWizardTestResult(null)
    setCreatedId(p.id)
    setWizardOpen(true)
  }

  function buildManifest() {
    return {
      paramDescription: '{ "input": "text input" }',
      executorType: 'webhook' as const,
      endpoint: form.endpoint.trim(),
      method: form.method,
      authType: form.authType,
      authCredentials: form.authCredentials.trim() || undefined,
      timeoutMs: Number(form.timeoutMs) || 15000,
      description: form.description.trim(),
    }
  }

  function validateStep(s: number): string | null {
    if (s === 1) {
      if (!form.name.trim()) return 'Plugin name is required.'
      if (!form.description.trim()) return 'Description is required.'
    }
    if (s === 2) {
      if (!form.toolId.trim()) return 'Tool ID is required.'
      if (!form.endpoint.trim()) return 'Endpoint URL is required.'
      try {
        new URL(form.endpoint.trim())
      } catch {
        return 'Endpoint URL is invalid.'
      }
    }
    return null
  }

  function nextStep() {
    const err = validateStep(step)
    if (err) {
      toast.error(err)
      return
    }
    setStep((s) => Math.min(s + 1, 4))
  }

  async function handleSave() {
    const err = validateStep(1) || validateStep(2)
    if (err) {
      toast.error(err)
      return
    }
    if (createdId && !editing) {
      toast.success('Plugin created.')
      setWizardOpen(false)
      fetchPlugins()
      return
    }

    setSaving(true)
    try {
      const manifest = buildManifest()
      const isEdit = editing !== null
      const url = isEdit ? `/api/tools/${editing!.id}` : '/api/tools'
      const method = isEdit ? 'PATCH' : 'POST'
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim(),
        manifest,
        category: form.category,
        keywords: form.keywords.trim(),
      }
      if (!isEdit) {
        body.toolId = form.toolId.trim()
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success(isEdit ? 'Plugin updated.' : 'Plugin created.')
        setWizardOpen(false)
        fetchPlugins()
      } else {
        toast.error(data.error || 'Failed to save plugin.')
      }
    } catch {
      toast.error('Failed to save plugin.')
    } finally {
      setSaving(false)
    }
  }

  async function handleWizardTest() {
    const err = validateStep(1) || validateStep(2)
    if (err) {
      toast.error(err)
      return
    }
    setTestingInWizard(true)
    setWizardTestResult(null)
    try {
      let pluginId = createdId
      if (!pluginId) {
        const manifest = buildManifest()
        const createRes = await fetch('/api/tools', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolId: form.toolId.trim(),
            name: form.name.trim(),
            description: form.description.trim(),
            manifest,
            category: form.category,
            keywords: form.keywords.trim(),
          }),
        })
        const createData = await createRes.json()
        if (!createData.ok) {
          toast.error(createData.error || 'Failed to create plugin for testing.')
          setTestingInWizard(false)
          return
        }
        pluginId = createData.data.id
        setCreatedId(pluginId!)
      } else if (editing) {
        const manifest = buildManifest()
        await fetch(`/api/tools/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name.trim(),
            description: form.description.trim(),
            manifest,
            category: form.category,
            keywords: form.keywords.trim(),
          }),
        })
      }

      const testRes = await fetch(`/api/tools/${pluginId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: form.testInput }),
      })
      const testData = await testRes.json()
      if (testData.ok) {
        setWizardTestResult(testData.result)
      } else {
        setWizardTestResult({
          ok: false, output: '', error: testData.error || 'Test failed.', latencyMs: 0,
        })
      }
    } catch {
      setWizardTestResult({ ok: false, output: '', error: 'Failed to run test.', latencyMs: 0 })
    } finally {
      setTestingInWizard(false)
    }
  }

  async function handleToggle(p: PluginRow) {
    setTogglingId(p.id)
    try {
      const res = await fetch(`/api/tools/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: !p.isEnabled }),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success(p.isEnabled ? 'Plugin disabled.' : 'Plugin enabled.')
        fetchPlugins()
      } else {
        toast.error(data.error || 'Failed to change status.')
      }
    } catch {
      toast.error('Failed to change status.')
    } finally {
      setTogglingId(null)
    }
  }

  async function handleContextChange(p: PluginRow, chat: boolean, agentic: boolean) {
    try {
      const res = await fetch(`/api/tools/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatEnabled: chat, agenticEnabled: agentic }),
      })
      const data = await res.json()
      if (data.ok) {
        fetchPlugins()
      } else {
        toast.error(data.error || 'Failed to update scope.')
      }
    } catch {
      toast.error('Failed to update scope.')
    }
  }

  async function handleDelete() {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/tools/${deleteId}`, { method: 'DELETE' })
      const data = await res.json()
      if (data.ok) {
        toast.success('Plugin deleted.')
        setDeleteId(null)
        fetchPlugins()
      } else {
        toast.error(data.error || 'Failed to delete plugin.')
      }
    } catch {
      toast.error('Failed to delete plugin.')
    } finally {
      setDeleting(false)
    }
  }

  function openTest(p: PluginRow) {
    setTestPlugin(p)
    setTestInput('')
    setTestResult(null)
  }

  async function handleRunTest() {
    if (!testPlugin) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(`/api/tools/${testPlugin.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: testInput }),
      })
      const data = await res.json()
      if (data.ok) {
        setTestResult(data.result)
      } else {
        setTestResult({ ok: false, output: '', error: data.error || 'Test failed.', latencyMs: 0 })
      }
    } catch {
      setTestResult({ ok: false, output: '', error: 'Failed to run test.', latencyMs: 0 })
    } finally {
      setTesting(false)
    }
  }

  const stepLabels = ['Basic Info', 'Endpoint', 'Authentication', 'Test']

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-1">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tools…"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Select value={catFilter} onValueChange={setCatFilter}>
            <SelectTrigger className="h-8 w-full text-xs sm:w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c} value={c} className="text-xs capitalize">
                  {c === 'all' ? 'All Categories' : c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1 rounded-md border border-border/70 p-0.5">
            {(['all', 'enabled', 'disabled'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={
                  'h-7 rounded px-2.5 text-xs font-medium transition-colors ' +
                  (statusFilter === s
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted')
                }
              >
                {s === 'all' ? 'All' : s === 'enabled' ? 'Active' : 'Inactive'}
              </button>
            ))}
          </div>
        </div>
        <Button size="sm" onClick={openCreate} className="h-7 text-xs gap-1.5 shrink-0">
          <Plus className="h-3.5 w-3.5" /> Add Tool
        </Button>
      </div>

      {filtered.length === 0 ? (
        <Card className="rounded-lg border">
          <CardContent className="py-16 flex flex-col items-center justify-center gap-3">
            <Puzzle className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {plugins.length === 0 ? 'No custom tools registered yet' : 'No matching tools'}
            </p>
            <Button size="sm" onClick={openCreate} className="h-7 text-xs gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add Custom Tool
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 min-h-[400px]">
          {filtered.map((p) => {
            const Icon = iconForCategory(p.category)
            return (
              <Card key={p.id} className="rounded-lg border p-4 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <code className="font-mono text-xs text-muted-foreground">
                        plugin:{p.toolId}
                      </code>
                    </div>
                  </div>
                  <TogglePopup
                    isEnabled={p.isEnabled}
                    chatEnabled={p.chatEnabled}
                    agenticEnabled={p.agenticEnabled}
                    disabled={togglingId === p.id}
                    onToggle={() => handleToggle(p)}
                    onContextChange={(chat, agentic) => handleContextChange(p, chat, agentic)}
                  />
                </div>

                <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2.5rem]">
                  {p.description || 'No description'}
                </p>

                <div className="flex flex-wrap items-center gap-1.5">
                  {p.manifest?.method && (
                    <Badge
                      className={
                        'text-xs shrink-0 ' +
                        (p.manifest.method === 'GET'
                          ? 'bg-info/15 text-info border-info/20'
                          : 'bg-primary/15 text-primary border-primary/20')
                      }
                    >
                      {p.manifest.method}
                    </Badge>
                  )}
                  {p.category && (
                    <Badge variant="secondary" className="text-xs capitalize shrink-0">
                      {p.category}
                    </Badge>
                  )}
                  {p.isEnabled ? (
                    <Badge className="text-xs bg-success/15 text-success border-success/20 shrink-0">
                      Active
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs shrink-0">Off</Badge>
                  )}
                </div>

                {p.manifest?.endpoint && (
                  <code className="font-mono text-xs text-muted-foreground truncate block">
                    {p.manifest.endpoint}
                  </code>
                )}

                <div className="flex items-center gap-1 pt-1 border-t border-border/40 mt-auto">
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => openTest(p)}>
                    <Play className="h-3 w-3" /> Test
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => openEdit(p)}>
                    <Pencil className="h-3 w-3" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
                    onClick={() => setDeleteId(p.id)}
                  >
                    <Trash2 className="h-3 w-3" /> Delete
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* Add/Edit wizard dialog */}
      <Dialog open={wizardOpen} onOpenChange={(open) => { if (!open) setWizardOpen(false) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {editing ? 'Edit Custom Tool' : 'Add Custom Tool'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {editing ? 'Update tool configuration.' : 'Register a new webhook-based custom tool.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-1">
            {stepLabels.map((label, i) => {
              const n = i + 1
              const done = n < step
              const active = n === step
              return (
                <div key={label} className="flex items-center gap-1 flex-1">
                  <div
                    className={
                      'flex h-5 w-5 items-center justify-center rounded-full text-xs font-medium shrink-0 ' +
                      (active
                        ? 'bg-primary text-primary-foreground'
                        : done
                          ? 'bg-primary/20 text-primary'
                          : 'bg-muted text-muted-foreground')
                    }
                  >
                    {done ? <Check className="h-3 w-3" /> : n}
                  </div>
                  <span className={'text-xs ' + (active ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    {label}
                  </span>
                  {n < stepLabels.length && <div className="flex-1 h-px bg-border/60 mx-1" />}
                </div>
              )
            })}
          </div>

          <div className="space-y-3 min-h-[180px]">
            {step === 1 && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Tool Name</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Check Warehouse Stock"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Description</Label>
                  <Textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Brief description of the tool's function"
                    className="text-xs min-h-[56px]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Category</Label>
                    <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PREDEFINED_CATEGORIES.map((c) => (
                          <SelectItem key={c} value={c} className="text-xs capitalize">{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Keywords</Label>
                    <Input
                      value={form.keywords}
                      onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                      placeholder="stock, warehouse, inventory"
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Tool ID</Label>
                  <Input
                    value={form.toolId}
                    onChange={(e) => setForm({ ...form, toolId: e.target.value })}
                    placeholder="check-stock"
                    className="h-8 text-xs font-mono"
                    disabled={editing !== null}
                  />
                  <p className="text-xs text-muted-foreground">
                    Unique ID, called with prefix <code className="font-mono">plugin:</code>
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Endpoint URL</Label>
                  <Input
                    value={form.endpoint}
                    onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                    placeholder="https://example.com/webhook"
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Method</Label>
                    <Select value={form.method} onValueChange={(v) => setForm({ ...form, method: v })}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="GET" className="text-xs">GET</SelectItem>
                        <SelectItem value="POST" className="text-xs">POST</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Timeout (ms)</Label>
                    <Input
                      type="number"
                      value={form.timeoutMs}
                      onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })}
                      className="h-8 text-xs"
                      min={1000}
                      max={120000}
                    />
                  </div>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Authentication Type</Label>
                  <Select value={form.authType} onValueChange={(v) => setForm({ ...form, authType: v })}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE" className="text-xs">NONE</SelectItem>
                      <SelectItem value="BEARER" className="text-xs">BEARER</SelectItem>
                      <SelectItem value="API_KEY_HEADER" className="text-xs">API_KEY_HEADER</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.authType !== 'NONE' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Credentials</Label>
                    <Input
                      type="password"
                      value={form.authCredentials}
                      onChange={(e) => setForm({ ...form, authCredentials: e.target.value })}
                      placeholder={editing ? '•••• (leave blank to keep)' : 'Token / API Key'}
                      className="h-8 text-xs font-mono"
                    />
                    <p className="text-xs text-muted-foreground">
                      {form.authType === 'BEARER'
                        ? 'Sent as Authorization: Bearer <value> header'
                        : 'Sent as X-API-Key: <value> header'}
                    </p>
                  </div>
                )}
                {form.authType === 'NONE' && (
                  <div className="flex items-center gap-2 rounded-md border border-border/60 p-2.5">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">No authentication. Public endpoint.</p>
                  </div>
                )}
              </>
            )}

            {step === 4 && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Test Input</Label>
                  <Textarea
                    value={form.testInput}
                    onChange={(e) => setForm({ ...form, testInput: e.target.value })}
                    placeholder='{"input": "hello world"} or free text'
                    className="text-xs font-mono min-h-[56px]"
                  />
                  <p className="text-xs text-muted-foreground">
                    {editing
                      ? 'Tool is saved. Click test to try the current endpoint.'
                      : 'Tool will be created then tested. Click "Test Now".'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5 w-full"
                  onClick={handleWizardTest}
                  disabled={testingInWizard}
                >
                  {testingInWizard ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Test Now
                </Button>
                {wizardTestResult && <TestResultBlock result={wizardTestResult} />}
              </>
            )}
          </div>

          <DialogFooter className="flex !justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep((s) => Math.max(s - 1, 1))}
              disabled={step === 1}
              className="h-7 text-xs gap-1"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </Button>
            <div className="flex items-center gap-2">
              {step < 4 ? (
                <Button size="sm" onClick={nextStep} className="h-7 text-xs gap-1">
                  Continue <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button size="sm" onClick={handleSave} disabled={saving} className="h-7 text-xs gap-1.5">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  Save
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test dialog */}
      <Dialog open={!!testPlugin} onOpenChange={(open) => { if (!open) setTestPlugin(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">Test Tool: {testPlugin?.name}</DialogTitle>
            <DialogDescription className="text-xs">
              Send input to the webhook endpoint and view the result.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Test Input</Label>
              <Textarea
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder='{"input": "hello world"} or free text'
                className="text-xs font-mono min-h-[56px]"
              />
            </div>
            <Button size="sm" onClick={handleRunTest} disabled={testing} className="h-7 text-xs gap-1.5 w-full">
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run Test
            </Button>
            {testResult && <TestResultBlock result={testResult} />}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null) }}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete Tool?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              This action cannot be undone. The tool will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-7 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="h-7 text-xs bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function TestResultBlock({ result }: { result: TestResult }) {
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 p-2.5">
      <div className="flex items-center gap-2">
        <Badge
          className={
            'text-xs ' +
            (result.ok
              ? 'bg-success/15 text-success border-success/20'
              : 'bg-destructive/15 text-destructive border-destructive/20')
          }
        >
          {result.ok ? 'SUCCESS' : 'FAILED'}
        </Badge>
        <span className="text-xs text-muted-foreground">{result.latencyMs}ms</span>
      </div>
      {result.error && <p className="text-xs text-destructive">{result.error}</p>}
      {result.output && (
        <pre className="font-mono text-xs bg-muted/40 p-2 rounded max-h-[160px] overflow-auto [scrollbar-width:thin] whitespace-pre-wrap break-all">
          {result.output}
        </pre>
      )}
    </div>
  )
}
