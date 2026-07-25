'use client'

import { useCallback, useEffect, useState } from 'react'
import { Clock, Plus, Pencil, Trash2, Power, Loader2, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'

import { describeCron, formatRelativeTime, previewNextRuns, SCHEDULE_PRESETS } from '@/lib/cron-describe'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadingState, EmptyState } from '@/components/ui/view-states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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

interface Schedule {
  id: string
  name: string
  cronExpr: string
  prompt: string
  isActive: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  lastResult: string | null
  createdAt: string
  updatedAt: string
}

function fmtDate(date: string | null): string {
  if (!date) return '-'
  return format(new Date(date), 'dd MMM yyyy HH:mm')
}

function lastStatusFromResult(lastResult: string | null): 'success' | 'error' | null {
  if (!lastResult) return null
  try {
    const parsed = JSON.parse(lastResult)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) return 'error'
    return 'success'
  } catch {
    return null
  }
}

export function SchedulesView() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [form, setForm] = useState({ name: '', cronExpr: '', prompt: '', isActive: true })
  const [saving, setSaving] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const fetchSchedules = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/schedules')
      const data = await res.json()
      if (data.ok) {
        setSchedules(data.schedules)
      } else {
        toast.error(data.error || 'Failed to load execution schedules.')
      }
    } catch {
      toast.error('Failed to load execution schedules.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSchedules()
  }, [fetchSchedules])

  function openCreate() {
    setEditing(null)
    setForm({ name: '', cronExpr: '', prompt: '', isActive: true })
    setDialogOpen(true)
  }

  function openEdit(s: Schedule) {
    setEditing(s)
    setForm({ name: s.name, cronExpr: s.cronExpr, prompt: s.prompt, isActive: s.isActive })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim() || !form.cronExpr.trim() || !form.prompt.trim()) {
      toast.error('All fields are required.')
      return
    }
    setSaving(true)
    try {
      const isEdit = editing !== null
      const url = isEdit ? `/api/schedules/${editing!.id}` : '/api/schedules'
      const method = isEdit ? 'PATCH' : 'POST'
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        cronExpr: form.cronExpr.trim(),
        prompt: form.prompt.trim(),
        isActive: form.isActive,
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success(isEdit ? 'Schedule updated.' : 'Schedule created.')
        setDialogOpen(false)
        fetchSchedules()
      } else {
        toast.error(data.error || 'Failed to save schedule.')
      }
    } catch {
      toast.error('Failed to save schedule.')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(s: Schedule) {
    setTogglingId(s.id)
    try {
      const res = await fetch(`/api/schedules/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !s.isActive }),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success(s.isActive ? 'Schedule disabled.' : 'Schedule enabled.')
        fetchSchedules()
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
      const res = await fetch(`/api/schedules/${deleteId}`, { method: 'DELETE' })
      const data = await res.json()
      if (data.ok) {
        toast.success('Schedule deleted.')
        setDeleteId(null)
        fetchSchedules()
      } else {
        toast.error(data.error || 'Failed to delete schedule.')
      }
    } catch {
      toast.error('Failed to delete schedule.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <Card className="rounded-none border border-border/70">
        <CardHeader className="py-3 px-3.5 gap-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <div>
                <CardTitle className="text-sm">Execution Schedules</CardTitle>
                <CardDescription className="text-xs">
                  Automate prompt execution based on cron schedules.
                </CardDescription>
              </div>
            </div>
            <Button size="sm" onClick={openCreate} className="h-7 text-xs gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Add Schedule
            </Button>
          </div>
        </CardHeader>
      </Card>

      {loading ? (
        <LoadingState />
      ) : schedules.length === 0 ? (
        <Card className="rounded-none border border-border/70">
          <CardContent className="p-0">
            <EmptyState
              icon={Clock}
              title="No execution schedules yet"
              action={
                <Button size="sm" onClick={openCreate} className="h-7 text-xs gap-1.5">
                  <Plus className="h-3.5 w-3.5" />
                  Add Schedule
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-none border border-border/70">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs h-8 py-2 px-3.5">Name</TableHead>
                  <TableHead className="text-xs h-8 py-2 px-3.5">Cron</TableHead>
                  <TableHead className="text-xs h-8 py-2 px-3.5">Prompt</TableHead>
                  <TableHead className="text-xs h-8 py-2 px-3.5">Next Execution</TableHead>
                  <TableHead className="text-xs h-8 py-2 px-3.5">Last Execution</TableHead>
                  <TableHead className="text-xs h-8 py-2 px-3.5">Last Status</TableHead>
                  <TableHead className="text-xs h-8 py-2 px-3.5">Status</TableHead>
                  <TableHead className="text-xs h-8 py-2 px-3.5 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => {
                  const status = lastStatusFromResult(s.lastResult)
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs py-2.5 px-3.5 font-medium">{s.name}</TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs">{describeCron(s.cronExpr)}</span>
                          <code className="font-mono text-xs bg-muted/40 px-1.5 py-0.5 rounded w-fit">{s.cronExpr}</code>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5 max-w-[200px]">
                        <p className="line-clamp-1 text-muted-foreground">{s.prompt}</p>
                      </TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs">{fmtDate(s.nextRunAt)}</span>
                          <span className="text-xs text-muted-foreground">{formatRelativeTime(s.nextRunAt)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs">{fmtDate(s.lastRunAt)}</span>
                          <span className="text-xs text-muted-foreground">{formatRelativeTime(s.lastRunAt)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5">
                        {status === 'success' ? (
                          <Badge className="text-xs bg-success/15 text-success border-success/20 gap-1">
                            <Check className="h-3 w-3" />
                            Success
                          </Badge>
                        ) : status === 'error' ? (
                          <Badge className="text-xs bg-destructive/15 text-destructive border-destructive/20 gap-1">
                            <X className="h-3 w-3" />
                            Failed
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5">
                        {s.isActive ? (
                          <Badge className="text-xs bg-success/15 text-success border-success/20">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">
                            Inactive
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => handleToggle(s)}
                            disabled={togglingId === s.id}
                            title={s.isActive ? 'Disable' : 'Enable'}
                          >
                            {togglingId === s.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Power className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => openEdit(s)}
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => setDeleteId(s.id)}
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {editing ? 'Edit Schedule' : 'Add Schedule'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {editing ? 'Update execution schedule details.' : 'Create a new execution schedule.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Daily sales summary"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Cron Expression</Label>
              <Input
                value={form.cronExpr}
                onChange={(e) => setForm({ ...form, cronExpr: e.target.value })}
                placeholder="0 9 * * *"
                className="h-8 text-xs font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Format: minute hour day month weekday (0-59 0-23 1-31 1-12 0-6)
              </p>
              {form.cronExpr && (
                <p className="text-xs text-muted-foreground">
                  {describeCron(form.cronExpr)}
                </p>
              )}
              <div className="max-h-[200px] overflow-y-auto rounded-none border border-border/70 p-2">
                <div className="grid grid-cols-2 gap-1.5">
                  {SCHEDULE_PRESETS.map((p) => (
                    <button
                      key={p.expr}
                      type="button"
                      onClick={() => setForm({ ...form, cronExpr: p.expr })}
                      className="text-left rounded-none border border-border/70 px-2 py-1.5 hover:bg-accent transition-colors"
                    >
                      <div className="text-xs font-medium">{p.label}</div>
                      <div className="text-xs text-muted-foreground">{p.description}</div>
                    </button>
                  ))}
                </div>
              </div>
              {form.cronExpr && describeCron(form.cronExpr) !== 'Invalid cron expression' && (
                <div className="rounded-none border border-border/70 bg-muted/20 p-2 space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Next 5 Executions</div>
                  {previewNextRuns(form.cronExpr).map((run, i) => (
                    <div key={i} className="text-xs flex items-center gap-2">
                      <span className="text-muted-foreground">{i + 1}.</span>
                      <span>{format(run, 'dd MMM yyyy, HH:mm')}</span>
                      <span className="text-muted-foreground">({formatRelativeTime(run.toISOString())})</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Prompt</Label>
              <Textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                placeholder="Show today's sales summary"
                className="text-xs min-h-[80px]"
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <Label className="text-xs">Active</Label>
              <Switch
                checked={form.isActive}
                onCheckedChange={(v) => setForm({ ...form, isActive: v })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(false)}
              className="h-7 text-xs"
            >
              Cancel
            </Button>
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

      <AlertDialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null)
        }}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete Schedule?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              This action cannot be undone. The execution schedule will be permanently deleted.
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
