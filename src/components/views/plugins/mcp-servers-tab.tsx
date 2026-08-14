'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Server,
  Search,
  Plus,
  Pencil,
  Trash2,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ListRowsSkeleton } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
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

import type { McpServerRow } from './types'
import { TogglePopup } from './toggle-popup'
import { McpServerDialog } from './mcp-server-dialog'
import { McpQuickConnect } from './mcp-quick-connect'

export function McpServersTab() {
  const [servers, setServers] = useState<McpServerRow[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [search, setSearch] = useState('')

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<McpServerRow | null>(null)

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return servers
    return servers.filter((s) =>
      [s.name, s.description, s.transport, s.command, s.url].join(' ').toLowerCase().includes(q),
    )
  }, [servers, search])

  function openCreate() {
    setEditing(null)
    setDialogOpen(true)
  }

  function openEdit(s: McpServerRow) {
    setEditing(s)
    setDialogOpen(true)
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
    return showSkeleton ? <ListRowsSkeleton count={3} /> : null
  }

  return (
    <div className="space-y-3">
      <McpQuickConnect onConnected={fetchServers} />

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
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate} className="h-7 text-xs">
          Add Server
        </Button>
      </div>

      {filtered.length === 0 ? (
        <Card className="rounded-lg border">
          <CardContent className="py-16 flex flex-col items-center justify-center gap-3">
            <Server className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {servers.length === 0 ? 'No MCP servers configured' : 'No matching servers'}
            </p>
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate} className="h-7 text-xs">
              Add MCP Server
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => (
            <Card key={s.id} className="rounded-lg border flex flex-col gap-2.5">
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
                <Button variant="ghost" size="sm" icon={<Pencil className="h-3 w-3" />} className="h-7 text-xs" onClick={() => openEdit(s)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 className="h-3 w-3" />}
                  className="h-7 text-xs text-destructive hover:text-destructive"
                  onClick={() => setDeleteId(s.id)}
                >
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <McpServerDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={fetchServers}
      />

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
