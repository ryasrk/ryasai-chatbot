'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Clock,
  Plus,
  Pencil,
  Trash2,
  Power,
  Loader2,
  Check,
  X,
  Download,
  History,
  Play,
  Search,
  Bell,
  Activity,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Database,
} from 'lucide-react'
import { toast } from 'sonner'
import { Stagger, StaggerItem } from '@/components/motion'
import { describeCron, formatRelativeTime, isScheduleOverdue } from '@/lib/cron-describe'
import { MetricCard } from '@/components/ui/metric-card'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ListRowsSkeleton, EmptyState, ErrorState } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { ScheduleFormDialog } from '@/components/views/schedules/schedule-form-dialog'
import { NotificationConfig, IntegrationOption, Schedule, fmtDate, lastStatusFromResult, RunHistoryItem } from '@/components/views/schedules/schedule-model'

export function SchedulesView() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [loadError, setLoadError] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  // Bumped on every open so the form dialog remounts with the opened schedule's values.
  const [formKey, setFormKey] = useState(0)
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
  const [integrations, setIntegrations] = useState<IntegrationOption[]>([])

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
    // Fetch data sources for the "restrict to this source" selector
    fetch('/api/integrations')
      .then((r) => r.json())
      .then((d) => { if (d.ok) setIntegrations(d.data) })
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
    setFormKey((k) => k + 1)
    setDialogOpen(true)
  }

  function openEdit(s: Schedule) {
    setEditing(s)
    setFormKey((k) => k + 1)
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
          <MetricCard label="Total Schedules" value={schedules.length} icon={Clock} iconClass="text-muted-foreground" />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            label="Active"
            value={schedules.filter((s) => s.isActive).length}
            icon={Activity}
            iconClass="text-success"
            valueClass="text-success"
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            label="Success Rate"
            value={(() => {
              const withResults = schedules.filter((s) => s.lastResult)
              if (withResults.length === 0) return '-'
              const successCount = withResults.filter((s) => lastStatusFromResult(s.lastResult) === 'success').length
              return `${Math.round((successCount / withResults.length) * 100)}%`
            })()}
            icon={CheckCircle2}
            iconClass="text-success"
            valueClass="text-success"
          />
        </StaggerItem>
        <StaggerItem>
          <MetricCard
            label="Failed"
            value={schedules.filter((s) => lastStatusFromResult(s.lastResult) === 'error').length}
            icon={AlertCircle}
            iconClass="text-destructive"
            valueClass="text-destructive"
          />
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
                  Automate prompt execution based on cron schedules. Each schedule runs in its own configured timezone.
                </CardDescription>
              </div>
            </div>
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate} className="h-7 text-xs gap-1.5">
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
                <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate} className="h-7 text-xs gap-1.5">
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
                          {s.integrationId && (
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Database className="h-2.5 w-2.5" />
                              {integrations.find((i) => i.id === s.integrationId)?.name ?? 'Restricted source'}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs">{describeCron(s.cronExpr)}</span>
                          <div className="flex items-center gap-1.5">
                            <code className="font-mono text-xs bg-muted/40 px-1.5 py-0.5 rounded w-fit">{s.cronExpr}</code>
                            <span className="text-[10px] text-muted-foreground">{s.timezone || 'UTC'}</span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5 max-w-[200px]">
                        <p className="line-clamp-1 text-muted-foreground">{s.prompt}</p>
                      </TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs">{fmtDate(s.nextRunAt, s.timezone)}</span>
                          <span className="text-xs text-muted-foreground">{formatRelativeTime(s.nextRunAt)}</span>
                          {/* A repeatable job stops rescheduling once it exhausts its attempts, and the
                              row keeps isActive=true with a nextRunAt that simply stops moving — so a
                              DEAD schedule renders identically to a healthy one. Measured: one died 41
                              days before this was noticed. */}
                          {isScheduleOverdue(s.nextRunAt, s.isActive) && (
                            <span
                              className="text-[11px] text-destructive"
                              title="This schedule is active but its next run is in the past. It may have stopped running — check the run history for failures."
                            >
                              Overdue — may have stopped
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs py-2.5 px-3.5">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs">{fmtDate(s.lastRunAt, s.timezone)}</span>
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

      <ScheduleFormDialog
        key={formKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        notificationConfigs={notificationConfigs}
        integrations={integrations}
        onSaved={fetchSchedules}
        onChannelCreated={(config) => setNotificationConfigs((prev) => [config, ...prev])}
      />

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
              <Button size="sm" variant="outline" icon={<Download className="h-3 w-3" />} className="h-7 text-xs gap-1.5" onClick={() => handleExport(historySchedule, 'json')}>
                Export JSON
              </Button>
              <Button size="sm" variant="outline" icon={<Download className="h-3 w-3" />} className="h-7 text-xs gap-1.5" onClick={() => handleExport(historySchedule, 'csv')}>
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
                      ) : run.status === 'skipped' ? (
                        // ponytail: a license lockdown must not render as
                        // "Failed" — the run never executed, so telling the
                        // operator to debug a nonexistent error wastes their
                        // time. Show the pause, and why.
                        <Badge
                          className="text-xs bg-warning/15 text-warning border-warning/20 gap-1"
                          title={run.error ?? undefined}
                        >
                          <AlertTriangle className="h-3 w-3" />
                          Skipped
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
