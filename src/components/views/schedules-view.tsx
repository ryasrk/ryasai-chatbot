'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, Plus, Pencil, Trash2, Power, Loader2, Check, X, Download, History, Play, Search, Bell, Activity, CheckCircle2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import { Stagger, StaggerItem } from '@/components/motion'

import { describeCron, formatRelativeTime, previewNextRuns } from '@/lib/cron-describe'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ListRowsSkeleton, EmptyState, ErrorState } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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

type RepeatType = 'daily' | 'weekdays' | 'weekends' | 'custom'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface NotificationConfig {
  id: string
  name: string
  type: string
  isActive: boolean
}

const QUICK_PRESETS = [
  { label: 'Every minute', cron: '* * * * *' },
  { label: 'Every 5 min', cron: '*/5 * * * *' },
  { label: 'Every 15 min', cron: '*/15 * * * *' },
  { label: 'Every 30 min', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily 9 AM', cron: '0 9 * * *' },
  { label: 'Daily 6 PM', cron: '0 18 * * *' },
  { label: 'Weekdays 9 AM', cron: '0 9 * * 1-5' },
  { label: 'First of month', cron: '0 9 1 * *' },
]

function buildCron(time: string, repeat: RepeatType, selectedDays: number[]): string {
  const [h, m] = time.split(':').map(Number)
  const hh = h ?? 0
  const mm = m ?? 0
  if (repeat === 'daily') return `${mm} ${hh} * * *`
  if (repeat === 'weekdays') return `${mm} ${hh} * * 1-5`
  if (repeat === 'weekends') return `${mm} ${hh} * * 0,6`
  if (repeat === 'custom' && selectedDays.length > 0) return `${mm} ${hh} * * ${selectedDays.sort().join(',')}`
  return `${mm} ${hh} * * *`
}

function parseCron(expr: string): { time: string; repeat: RepeatType; selectedDays: number[] } {
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 5) return { time: '09:00', repeat: 'daily', selectedDays: [] }
  const mm = parts[0]
  const hh = parts[1]
  const dow = parts[4]
  const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
  if (dow === '*') return { time, repeat: 'daily', selectedDays: [] }
  if (dow === '1-5') return { time, repeat: 'weekdays', selectedDays: [] }
  if (dow === '0,6' || dow === '6,0') return { time, repeat: 'weekends', selectedDays: [] }
  const days = dow.split(',').map(Number).filter((n) => !isNaN(n))
  return { time, repeat: 'custom', selectedDays: days }
}

interface Schedule {
  id: string
  name: string
  cronExpr: string
  prompt: string
  isActive: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  lastResult: string | null
  notificationConfigId: string | null
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

interface RunHistoryItem {
  id: string
  status: string
  answer: string | null
  error: string | null
  toolRuns: Array<{ type: string; status: string; outputSummary?: string }> | null
  latencyMs: number | null
  executedAt: string
}

export function SchedulesView() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [loadError, setLoadError] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [form, setForm] = useState({ name: '', cronExpr: '', prompt: '', isActive: true, notificationConfigId: '' })
  const [scheduleTime, setScheduleTime] = useState('09:00')
  const timeInputRef = useRef<HTMLInputElement>(null)
  const [repeatType, setRepeatType] = useState<RepeatType>('daily')
  const [selectedDays, setSelectedDays] = useState<number[]>([])
  const [customCron, setCustomCron] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [historySchedule, setHistorySchedule] = useState<Schedule | null>(null)
  const [historyRuns, setHistoryRuns] = useState<RunHistoryItem[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const showHistorySkeleton = useDelayedLoading(loadingHistory)
  const prevLastRunMap = useRef<Map<string, string>>(new Map())
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [notificationConfigs, setNotificationConfigs] = useState<NotificationConfig[]>([])

  const fetchSchedules = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const res = await fetch('/api/schedules')
      const data = await res.json()
      if (data.ok) {
        setSchedules(data.schedules)
      } else {
        setLoadError(true)
        toast.error(data.error || 'Failed to load execution schedules.')
      }
    } catch {
      setLoadError(true)
      toast.error('Failed to load execution schedules.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSchedules()
    // Fetch notification configs for the selector
    fetch('/api/notifications')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setNotificationConfigs(d.configs) })
      .catch(() => {})
  }, [fetchSchedules])

  // ponytail: poll every 15s for schedule changes — detects when the scheduler
  // completes a run. Shows a toast notification with the result.
  useEffect(() => {
    const interval = setInterval(async () => {
      // ponytail: no point polling a tab nobody is looking at
      if (document.hidden) return
      try {
        const res = await fetch('/api/schedules', { cache: 'no-store' })
        const data = await res.json()
        if (!data.ok) return
        const newSchedules: Schedule[] = data.schedules
        for (const s of newSchedules) {
          const prev = prevLastRunMap.current.get(s.id)
          if (prev && s.lastRunAt && prev !== s.lastRunAt) {
            const status = lastStatusFromResult(s.lastResult)
            if (status === 'success') {
              toast.success(`Schedule "${s.name}" completed successfully.`)
            } else if (status === 'error') {
              toast.error(`Schedule "${s.name}" failed.`)
            }
          }
          if (s.lastRunAt) prevLastRunMap.current.set(s.id, s.lastRunAt)
        }
        setSchedules(newSchedules)
      } catch {}
    }, 15_000)
    return () => clearInterval(interval)
  }, [])

  function openCreate() {
    setEditing(null)
    setForm({ name: '', cronExpr: '', prompt: '', isActive: true, notificationConfigId: '' })
    setScheduleTime('09:00')
    setRepeatType('daily')
    setSelectedDays([])
    setCustomCron(null)
    setDialogOpen(true)
  }

  function openEdit(s: Schedule) {
    setEditing(s)
    const parsed = parseCron(s.cronExpr)
    setForm({ name: s.name, cronExpr: s.cronExpr, prompt: s.prompt, isActive: s.isActive, notificationConfigId: s.notificationConfigId ?? '' })
    setScheduleTime(parsed.time)
    setRepeatType(parsed.repeat)
    setSelectedDays(parsed.selectedDays)
    setCustomCron(parsed ? null : s.cronExpr)
    setDialogOpen(true)
  }

  async function handleRunNow(s: Schedule) {
    setRunningId(s.id)
    try {
      const res = await fetch(`/api/schedules/${s.id}/run`, { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        toast.success(`"${s.name}" triggered — result will appear in history shortly.`)
      } else {
        toast.error(data.error || 'Failed to trigger schedule.')
      }
    } catch {
      toast.error('Failed to trigger schedule.')
    } finally {
      setRunningId(null)
    }
  }

  async function handleSave() {
    const cronExpr = customCron ?? buildCron(scheduleTime, repeatType, selectedDays)
    if (!form.name.trim() || !cronExpr.trim() || !form.prompt.trim()) {
      toast.error('All fields are required.')
      return
    }
    if (repeatType === 'custom' && selectedDays.length === 0) {
      toast.error('Select at least one day.')
      return
    }
    setSaving(true)
    try {
      const isEdit = editing !== null
      const url = isEdit ? `/api/schedules/${editing!.id}` : '/api/schedules'
      const method = isEdit ? 'PATCH' : 'POST'
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        cronExpr,
        prompt: form.prompt.trim(),
        isActive: form.isActive,
        notificationConfigId: form.notificationConfigId || null,
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

  async function loadHistory(s: Schedule) {
    setHistorySchedule(s)
    setLoadingHistory(true)
    setHistoryRuns([])
    try {
      const res = await fetch(`/api/schedules/${s.id}/runs`)
      const data = await res.json()
      if (data.ok) {
        setHistoryRuns(data.runs)
      } else {
        toast.error(data.error || 'Failed to load execution history.')
      }
    } catch {
      toast.error('Failed to load execution history.')
    } finally {
      setLoadingHistory(false)
    }
  }

  function handleExport(s: Schedule, format: 'json' | 'csv') {
    window.open(`/api/schedules/${s.id}/runs/export?format=${format}`, '_blank')
  }

  return (
    <div className="space-y-3">
      {/* Stats summary */}
      <Stagger className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <StaggerItem>
        <Card>
          <CardContent className="flex items-center justify-between py-3 px-3.5">
            <div>
              <div className="text-lg font-semibold tabular-nums leading-tight">{schedules.length}</div>
              <div className="text-xs text-muted-foreground">Total Schedules</div>
            </div>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardContent>
        </Card>
        </StaggerItem>
        <StaggerItem>
        <Card>
          <CardContent className="flex items-center justify-between py-3 px-3.5">
            <div>
              <div className="text-lg font-semibold tabular-nums leading-tight text-success">{schedules.filter((s) => s.isActive).length}</div>
              <div className="text-xs text-muted-foreground">Active</div>
            </div>
            <Activity className="h-4 w-4 text-success" />
          </CardContent>
        </Card>
        </StaggerItem>
        <StaggerItem>
        <Card>
          <CardContent className="flex items-center justify-between py-3 px-3.5">
            <div>
              <div className="text-lg font-semibold tabular-nums leading-tight text-success">
                {(() => {
                  const withResults = schedules.filter((s) => s.lastResult)
                  if (withResults.length === 0) return '-'
                  const successCount = withResults.filter((s) => lastStatusFromResult(s.lastResult) === 'success').length
                  return `${Math.round((successCount / withResults.length) * 100)}%`
                })()}
              </div>
              <div className="text-xs text-muted-foreground">Success Rate</div>
            </div>
            <CheckCircle2 className="h-4 w-4 text-success" />
          </CardContent>
        </Card>
        </StaggerItem>
        <StaggerItem>
        <Card>
          <CardContent className="flex items-center justify-between py-3 px-3.5">
            <div>
              <div className="text-lg font-semibold tabular-nums leading-tight text-destructive">
                {schedules.filter((s) => lastStatusFromResult(s.lastResult) === 'error').length}
              </div>
              <div className="text-xs text-muted-foreground">Failed</div>
            </div>
            <AlertCircle className="h-4 w-4 text-destructive" />
          </CardContent>
        </Card>
        </StaggerItem>
      </Stagger>

      <Card className="rounded-none border border-border/70">
        <CardHeader className="py-3 px-3.5 gap-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <div>
                <CardTitle className="text-sm">Execution Schedules</CardTitle>
                <CardDescription className="text-xs">
                  Automate prompt execution based on cron schedules. Times are in UTC.
                </CardDescription>
              </div>
            </div>
            <Button size="sm" onClick={openCreate} className="h-7 text-xs gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Add Schedule
            </Button>
          </div>
          {/* Search + filter */}
          {schedules.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <div className="relative flex-1 max-w-[240px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search schedules..."
                  className="h-7 text-xs pl-7"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | 'active' | 'inactive')}>
                <SelectTrigger className="h-7 text-xs w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </CardHeader>
      </Card>

      {/* ponytail: gate on `loading`, not on `showSkeleton`. Without it the
          first 200 ms (before the delayed skeleton appears) fell through to the
          empty state, so the page painted "No schedules yet" → skeleton → table.
          Three layouts in one load is what wrecked Speed Index here. */}
      {loading ? (
        showSkeleton ? <ListRowsSkeleton /> : null
      ) : loadError ? (
        <ErrorState message="Failed to load execution schedules." onRetry={fetchSchedules} />
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
                {schedules
                  .filter((s) => {
                    if (statusFilter === 'active' && !s.isActive) return false
                    if (statusFilter === 'inactive' && s.isActive) return false
                    if (searchQuery && !s.name.toLowerCase().includes(searchQuery.toLowerCase()) && !s.prompt.toLowerCase().includes(searchQuery.toLowerCase())) return false
                    return true
                  })
                  .map((s) => {
                  const status = lastStatusFromResult(s.lastResult)
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs py-2.5 px-3.5 font-medium">
                        <div className="flex flex-col gap-0.5">
                          {s.name}
                          {s.notificationConfigId && (
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Bell className="h-2.5 w-2.5" />
                              {notificationConfigs.find((c) => c.id === s.notificationConfigId)?.name ?? 'Notification'}
                            </span>
                          )}
                        </div>
                      </TableCell>
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
                             onClick={() => handleRunNow(s)}
                             disabled={runningId === s.id}
                             title="Run Now"
                           >
                             {runningId === s.id ? (
                               <Loader2 className="h-3.5 w-3.5 animate-spin" />
                             ) : (
                               <Play className="h-3.5 w-3.5" />
                             )}
                           </Button>
                           {s.lastResult && (
                             <Button
                               variant="ghost"
                               size="icon"
                               className="h-7 w-7"
                               onClick={() => loadHistory(s)}
                               title="Execution History"
                             >
                               <History className="h-3.5 w-3.5" />
                             </Button>
                           )}
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
              <Label className="text-xs">Schedule</Label>
              {/* Quick presets */}
              <div className="flex flex-wrap gap-1.5">
                {QUICK_PRESETS.map((p) => {
                  const currentCron = customCron ?? buildCron(scheduleTime, repeatType, selectedDays)
                  const isActive = currentCron === p.cron
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => {
                        setCustomCron(p.cron)
                      }}
                      className={cn(
                        'text-[10px] px-2 py-1 rounded-md border transition-colors',
                        isActive
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card text-muted-foreground border-border/70 hover:bg-accent'
                      )}
                    >
                      {p.label}
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-3 rounded-none border border-border/70 p-3 bg-muted/20">
                <label className="cursor-pointer">
                  <span
                    className="text-2xl font-light tracking-wide hover:text-primary transition-colors"
                    onClick={() => timeInputRef.current?.showPicker?.()}
                  >
                    {scheduleTime}
                  </span>
                  <input
                    ref={timeInputRef}
                    type="time"
                    value={scheduleTime}
                    onChange={(e) => { setScheduleTime(e.target.value); setCustomCron(null) }}
                    className="sr-only"
                  />
                </label>
                <div className="flex-1" />
                <Select
                  value={repeatType}
                  onValueChange={(v) => {
                    setRepeatType(v as RepeatType)
                    setCustomCron(null)
                    if (v !== 'custom') setSelectedDays([])
                  }}
                >
                  <SelectTrigger className="h-8 text-xs w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Every day</SelectItem>
                    <SelectItem value="weekdays">Weekdays (Mon–Fri)</SelectItem>
                    <SelectItem value="weekends">Weekends (Sat–Sun)</SelectItem>
                    <SelectItem value="custom">Custom days...</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {repeatType === 'custom' && (
                <div className="flex gap-1.5 flex-wrap">
                  {WEEKDAYS.map((day, i) => {
                    const active = selectedDays.includes(i)
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          setSelectedDays((prev) =>
                            active ? prev.filter((d) => d !== i) : [...prev, i]
                          )
                          setCustomCron(null)
                        }}
                        className={cn(
                          'h-8 w-12 text-xs rounded-md border transition-colors',
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-card text-muted-foreground border-border/70 hover:bg-accent'
                        )}
                      >
                        {day}
                      </button>
                    )
                  })}
                </div>
              )}
              {(() => {
                const cronExpr = customCron ?? buildCron(scheduleTime, repeatType, selectedDays)
                return (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {describeCron(cronExpr)} &nbsp; <code className="font-mono text-[10px] bg-muted/40 px-1 py-0.5 rounded">{cronExpr}</code>
                    </p>
                    {describeCron(cronExpr) !== 'Invalid cron expression' && (
                      <div className="rounded-none border border-border/70 bg-muted/20 p-2 space-y-1">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">Next 5 Executions</div>
                        {previewNextRuns(cronExpr).map((run, i) => (
                          <div key={i} className="text-xs flex items-center gap-2">
                            <span className="text-muted-foreground">{i + 1}.</span>
                            <span>{format(run, 'dd MMM yyyy, HH:mm')}</span>
                            <span className="text-muted-foreground">({formatRelativeTime(run.toISOString())})</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )
              })()}
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
            {notificationConfigs.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1.5">
                  <Bell className="h-3 w-3" />
                  Notification Channel
                </Label>
                <Select
                  value={form.notificationConfigId || 'none'}
                  onValueChange={(v) => setForm({ ...form, notificationConfigId: v === 'none' ? '' : v })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No notification</SelectItem>
                    {notificationConfigs.filter((c) => c.isActive).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} ({c.type})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
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

      <Dialog open={historySchedule !== null} onOpenChange={(open) => { if (!open) { setHistorySchedule(null); setHistoryRuns([]) } }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <History className="h-4 w-4" />
              {historySchedule?.name} — Execution History
            </DialogTitle>
            <DialogDescription className="text-xs">
              {historySchedule ? `Cron: ${historySchedule.cronExpr}` : ''}
            </DialogDescription>
          </DialogHeader>

          {historySchedule && (
            <div className="flex items-center gap-2 pb-2 border-b">
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => handleExport(historySchedule, 'json')}>
                <Download className="h-3 w-3" />
                Export JSON
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => handleExport(historySchedule, 'csv')}>
                <Download className="h-3 w-3" />
                Export CSV
              </Button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto space-y-2">
            {showHistorySkeleton ? (
              <ListRowsSkeleton count={4} />
            ) : historyRuns.length === 0 ? (
              <div className="text-center py-8 text-xs text-muted-foreground">
                No execution history yet.
              </div>
            ) : (
              historyRuns.map((run) => (
                <div key={run.id} className="rounded-md border bg-muted/20 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {run.status === 'success' ? (
                        <Badge className="text-xs bg-success/15 text-success border-success/20 gap-1">
                          <Check className="h-3 w-3" />
                          Success
                        </Badge>
                      ) : (
                        <Badge className="text-xs bg-destructive/15 text-destructive border-destructive/20 gap-1">
                          <X className="h-3 w-3" />
                          Failed
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {fmtDate(run.executedAt)}
                      </span>
                      {run.latencyMs != null && (
                        <span className="text-xs text-muted-foreground">
                          ({(run.latencyMs / 1000).toFixed(1)}s)
                        </span>
                      )}
                    </div>
                  </div>
                  {run.toolRuns && run.toolRuns.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {run.toolRuns.map((tr, i) => (
                        <Badge key={i} variant="outline" className="text-[10px] gap-1">
                          {tr.type}
                          {tr.status === 'success' ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {run.error ? (
                    <pre className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                      {run.error}
                    </pre>
                  ) : (
                    <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-xs max-h-[200px] overflow-y-auto">
                      {run.answer || '(empty)'}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
