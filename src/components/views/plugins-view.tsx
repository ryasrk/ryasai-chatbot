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
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
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
  category?: string
  subcategory?: string
  keywords?: string
  createdAt: string
  updatedAt: string
}

interface TestResult {
  ok: boolean
  output: string
  error?: string
  latencyMs: number
}

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

export function PluginsView() {
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
        toast.error(data.error || 'Failed to load plugin list.')
      }
    } catch {
      toast.error('Failed to load plugin list.')
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
      if (editing && !form.toolId.trim()) return 'Tool ID is required.'
      if (!editing && !form.toolId.trim()) return 'Tool ID is required.'
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
    // If the wizard test already created the plugin, nothing left to persist.
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
      // Create the plugin first if it doesn't exist yet (create mode only).
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
        // Update existing plugin before testing so endpoint changes take effect.
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
          ok: false,
          output: '',
          error: testData.error || 'Test failed.',
          latencyMs: 0,
        })
      }
    } catch {
      setWizardTestResult({
        ok: false,
        output: '',
        error: 'Failed to run test.',
        latencyMs: 0,
      })
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
        setTestResult({
          ok: false,
          output: '',
          error: data.error || 'Test failed.',
          latencyMs: 0,
        })
      }
    } catch {
      setTestResult({
        ok: false,
        output: '',
        error: 'Failed to run test.',
        latencyMs: 0,
      })
    } finally {
      setTesting(false)
    }
  }

  const stepLabels = ['Basic Info', 'Endpoint', 'Authentication', 'Test']

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Puzzle className="h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Plugin Marketplace</h2>
            <p className="text-xs text-muted-foreground">
              Install, test, and manage external webhook plugins for the AI planner.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={openCreate} className="h-7 text-xs gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add Plugin
        </Button>
      </div>

      {/* Search + filter bar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, description, tool ID, keyword…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="h-8 w-full text-xs sm:w-[160px]">
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

      {/* Plugin grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="rounded-lg border">
          <CardContent className="py-16 flex flex-col items-center justify-center gap-3">
            <Puzzle className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {plugins.length === 0 ? 'No plugins registered yet' : 'No matching plugins'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 min-h-[400px]">
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
                  <Switch
                    checked={p.isEnabled}
                    onCheckedChange={() => handleToggle(p)}
                    disabled={togglingId === p.id}
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
                    <Badge variant="secondary" className="text-xs shrink-0">
                      Off
                    </Badge>
                  )}
                </div>

                {p.manifest?.endpoint && (
                  <code className="font-mono text-xs text-muted-foreground truncate block">
                    {p.manifest.endpoint}
                  </code>
                )}

                <div className="flex items-center gap-1 pt-1 border-t border-border/40 mt-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => openTest(p)}
                  >
                    <Play className="h-3 w-3" /> Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => openEdit(p)}
                  >
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
              {editing ? 'Edit Plugin' : 'Add Plugin'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {editing ? 'Update plugin configuration.' : 'Register a new webhook plugin.'}
            </DialogDescription>
          </DialogHeader>

          {/* Step indicator */}
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
                  <Label className="text-xs">Plugin Name</Label>
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
                    placeholder="Brief description of the plugin's function"
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
                          <SelectItem key={c} value={c} className="text-xs capitalize">
                            {c}
                          </SelectItem>
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
                    <p className="text-xs text-muted-foreground">
                      No authentication. Public endpoint.
                    </p>
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
                      ? 'Plugin is saved. Click test to try the current endpoint.'
                      : 'Plugin will be created then tested. Click "Test Now".'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5 w-full"
                  onClick={handleWizardTest}
                  disabled={testingInWizard}
                >
                  {testingInWizard ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  Test Now
                </Button>
                {wizardTestResult && (
                  <TestResultBlock result={wizardTestResult} />
                )}
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
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving}
                  className="h-7 text-xs gap-1.5"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
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
            <DialogTitle className="text-sm">Test Plugin: {testPlugin?.name}</DialogTitle>
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
            <Button
              size="sm"
              onClick={handleRunTest}
              disabled={testing}
              className="h-7 text-xs gap-1.5 w-full"
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Run Test
            </Button>
            {testResult && <TestResultBlock result={testResult} />}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open) setDeleteId(null) }}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete Plugin?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              This action cannot be undone. The plugin will be permanently deleted.
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
      {result.error && (
        <p className="text-xs text-destructive">{result.error}</p>
      )}
      {result.output && (
        <pre className="font-mono text-xs bg-muted/40 p-2 rounded max-h-[160px] overflow-auto [scrollbar-width:thin] whitespace-pre-wrap break-all">
          {result.output}
        </pre>
      )}
    </div>
  )
}
