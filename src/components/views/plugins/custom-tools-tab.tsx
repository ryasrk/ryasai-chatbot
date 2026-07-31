'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Puzzle,
  Search,
  Plus,
  Play,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ListRowsSkeleton } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
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

import type { PluginRow, TestResult } from './types'
import { CustomToolsWizard, PREDEFINED_CATEGORIES } from './custom-tools-wizard'
import { CustomToolCard } from './custom-tools-card'
import { TestResultBlock } from './test-result-block'

export function CustomToolsTab() {
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all')

  const [wizardOpen, setWizardOpen] = useState(false)
  const [editing, setEditing] = useState<PluginRow | null>(null)

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
    setWizardOpen(true)
  }

  function openEdit(p: PluginRow) {
    setEditing(p)
    setWizardOpen(true)
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

  if (loading) {
    return showSkeleton ? <ListRowsSkeleton count={3} /> : null
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
          {filtered.map((p) => (
            <CustomToolCard
              key={p.id}
              plugin={p}
              toggling={togglingId === p.id}
              onToggle={() => handleToggle(p)}
              onContextChange={(chat, agentic) => handleContextChange(p, chat, agentic)}
              onTest={() => openTest(p)}
              onEdit={() => openEdit(p)}
              onDelete={() => setDeleteId(p.id)}
            />
          ))}
        </div>
      )}

      <CustomToolsWizard
        open={wizardOpen}
        editing={editing}
        onClose={() => setWizardOpen(false)}
        onSaved={fetchPlugins}
      />

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
