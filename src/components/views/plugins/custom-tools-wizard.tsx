'use client'

import { useEffect, useState } from 'react'
import {
  Play,
  Loader2,
  Check,
  ChevronLeft,
  ChevronRight,
  Globe,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
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

import type { PluginRow, TestResult } from './types'
import { TestResultBlock } from './test-result-block'

export const PREDEFINED_CATEGORIES = [
  'general',
  'database',
  'api',
  'monitoring',
  'security',
  'productivity',
]

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

const STEP_LABELS = ['Basic Info', 'Endpoint', 'Authentication', 'Test']

interface WizardProps {
  open: boolean
  editing: PluginRow | null
  onClose: () => void
  onSaved: () => void
}

export function CustomToolsWizard({ open, editing, onClose, onSaved }: WizardProps) {
  const [step, setStep] = useState(1)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [testingInWizard, setTestingInWizard] = useState(false)
  const [wizardTestResult, setWizardTestResult] = useState<TestResult | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (editing) {
      setForm({
        toolId: editing.toolId,
        name: editing.name,
        description: editing.description,
        category: editing.category || 'general',
        keywords: editing.keywords || '',
        endpoint: editing.manifest?.endpoint || '',
        method: editing.manifest?.method || 'POST',
        timeoutMs: editing.manifest?.timeoutMs || 15000,
        authType: editing.manifest?.authType || 'NONE',
        authCredentials: '',
        testInput: '',
      })
      setCreatedId(editing.id)
    } else {
      setForm({ ...EMPTY_FORM })
      setCreatedId(null)
    }
    setStep(1)
    setWizardTestResult(null)
  }, [open, editing])

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
      onClose()
      onSaved()
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
        onClose()
        onSaved()
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

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
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
          {STEP_LABELS.map((label, i) => {
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
                {n < STEP_LABELS.length && <div className="flex-1 h-px bg-border/60 mx-1" />}
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
  )
}
