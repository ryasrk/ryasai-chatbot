'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Server,
  Globe,
  Zap,
  Search,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Check,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
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

import type { McpServerRow, McpTestState } from './types'
import { TogglePopup } from './toggle-popup'

const EMPTY_MCP_FORM = {
  name: '',
  description: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  envVars: '',
}

export function McpServersTab() {
  const [servers, setServers] = useState<McpServerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<McpServerRow | null>(null)
  const [form, setForm] = useState({ ...EMPTY_MCP_FORM })
  const [saving, setSaving] = useState(false)
  const [mcpTestResult, setMcpTestResult] = useState<McpTestState | null>(null)

  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  // ponytail: Quick Add by URL — create + test an SSE/HTTP MCP server in one
  // shot without opening the full add dialog. Reuses McpTestResultBlock for
  // inline results. The POST/test flow is the same as handleSave's test step.
  const [quickUrl, setQuickUrl] = useState('')
  const [quickConnecting, setQuickConnecting] = useState(false)
  const [quickResult, setQuickResult] = useState<McpTestState | null>(null)

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
    setMcpTestResult(null)
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
    setMcpTestResult(null)
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
    setMcpTestResult({ status: 'testing' })
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
      if (!data.ok) {
        toast.error(data.error || 'Failed to save MCP server.')
        setMcpTestResult(null)
        return
      }

      toast.success(isEdit ? 'MCP server updated.' : 'MCP server added.')
      fetchServers()

      // Agentic installation: test the connection and report tools inline.
      const createdId = isEdit ? editing!.id : data.server?.id
      if (!createdId) {
        setMcpTestResult(null)
        setDialogOpen(false)
        return
      }
      try {
        const testRes = await fetch(`/api/mcp/servers/${createdId}/test`, { method: 'POST' })
        const testData = await testRes.json()
        if (testData.ok) {
          setMcpTestResult({ status: 'success', tools: testData.tools ?? [] })
        } else {
          setMcpTestResult({ status: 'error', error: testData.error || 'Connection test failed.' })
        }
      } catch (e) {
        setMcpTestResult({
          status: 'error',
          error: e instanceof Error ? e.message : 'Connection test failed.',
        })
      }
    } catch {
      toast.error('Failed to save MCP server.')
      setMcpTestResult(null)
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

  async function handleQuickConnect() {
    const raw = quickUrl.trim()
    if (!raw) {
      toast.error('Paste an MCP URL first.')
      return
    }
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      toast.error('Invalid URL.')
      return
    }
    const transport = raw.toLowerCase().includes('/sse') ? 'sse' : 'http'
    setQuickConnecting(true)
    setQuickResult({ status: 'testing' })
    try {
      const res = await fetch('/api/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: parsed.hostname,
          description: 'Quick-added via URL',
          transport,
          command: '',
          args: [],
          url: raw,
          envVars: {},
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        setQuickResult({ status: 'error', error: data.error || 'Failed to create server.' })
        return
      }
      fetchServers()
      const id = data.server?.id
      if (!id) {
        setQuickResult(null)
        return
      }
      const testRes = await fetch(`/api/mcp/servers/${id}/test`, { method: 'POST' })
      const testData = await testRes.json()
      if (testData.ok) {
        setQuickResult({ status: 'success', tools: testData.tools ?? [] })
        setQuickUrl('')
      } else {
        setQuickResult({ status: 'error', error: testData.error || 'Connection test failed.' })
      }
    } catch (e) {
      setQuickResult({
        status: 'error',
        error: e instanceof Error ? e.message : 'Connection failed.',
      })
    } finally {
      setQuickConnecting(false)
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
      {/* Quick Add by URL — paste an MCP endpoint URL and connect in one step */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-md border border-border/60 p-2">
          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            value={quickUrl}
            onChange={(e) => setQuickUrl(e.target.value)}
            placeholder="Paste MCP URL (…/sse or …/mcp) for quick connect"
            className="h-7 text-xs flex-1 border-0 shadow-none focus-visible:ring-0"
            onKeyDown={(e) => { if (e.key === 'Enter' && !quickConnecting) handleQuickConnect() }}
          />
          <Button
            size="sm"
            onClick={handleQuickConnect}
            disabled={quickConnecting || !quickUrl.trim()}
            className="h-7 text-xs gap-1.5 shrink-0"
          >
            {quickConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            Connect
          </Button>
        </div>
        {quickResult && <McpTestResultBlock result={quickResult} />}
      </div>

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

          {mcpTestResult && (
            <McpTestResultBlock result={mcpTestResult} />
          )}

          <DialogFooter className="flex !justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setDialogOpen(false); setMcpTestResult(null) }}
              disabled={saving}
              className="h-7 text-xs"
            >
              {mcpTestResult ? 'Close' : 'Cancel'}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              className="h-7 text-xs gap-1.5"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {mcpTestResult?.status === 'error' ? 'Retry' : 'Save'}
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

function McpTestResultBlock({ result }: { result: McpTestState }) {
  if (result.status === 'testing') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 p-2.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Installing and detecting tools...</span>
      </div>
    )
  }
  if (result.status === 'error') {
    return (
      <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
          <span className="text-xs font-medium text-destructive">Connection failed</span>
        </div>
        <p className="text-xs text-destructive">{result.error}</p>
        <p className="text-xs text-muted-foreground">Edit the config to fix, then click Retry.</p>
      </div>
    )
  }
  const tools = result.tools ?? []
  return (
    <div className="space-y-1.5 rounded-md border border-success/30 bg-success/5 p-2.5">
      <div className="flex items-center gap-2">
        <Check className="h-3.5 w-3.5 text-success" />
        <span className="text-xs font-medium text-success">
          Connected! Found {tools.length} tool{tools.length === 1 ? '' : 's'}:
        </span>
      </div>
      {tools.length > 0 && (
        <ul className="space-y-1 max-h-[140px] overflow-auto [scrollbar-width:thin]">
          {tools.map((t) => (
            <li key={t.name} className="text-xs">
              <code className="font-mono text-foreground">{t.name}</code>
              {t.description && <span className="text-muted-foreground"> — {t.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
