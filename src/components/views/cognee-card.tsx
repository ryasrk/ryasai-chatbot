'use client'

import { useEffect, useState } from 'react'
import {
  Brain,
  Check,
  Loader2,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Delayed } from '@/components/ui/view-states'

interface CogneeStats {
  enabled: boolean
  connected: boolean
  mode: 'local' | 'postgres' | 'disabled'
  documents: { total: number; cognified: number; pending: number; failed: number }
  batchSize: number
  maxRetries: number
  config?: {
    enabled: boolean
    dbProvider: string
    dbUrl: string
    batchSize: number
    maxRetries: number
  } | null
}

export function CogneeCard() {
  const [stats, setStats] = useState<CogneeStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [showConfig, setShowConfig] = useState(false)
  const [cfgEnabled, setCfgEnabled] = useState(false)
  const [cfgProvider, setCfgProvider] = useState<'local' | 'postgres'>('local')
  const [cfgDbUrl, setCfgDbUrl] = useState('')
  const [cfgBatchSize, setCfgBatchSize] = useState(50)
  const [cfgMaxRetries, setCfgMaxRetries] = useState(3)
  const [saving, setSaving] = useState(false)

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/cognee')
      const data = await res.json()
      if (data.ok) {
        setStats(data.data)
        if (data.data.config) {
          setCfgEnabled(data.data.config.enabled)
          setCfgProvider(data.data.config.dbProvider as 'local' | 'postgres')
          setCfgDbUrl(data.data.config.dbUrl)
          setCfgBatchSize(data.data.config.batchSize)
          setCfgMaxRetries(data.data.config.maxRetries)
        }
      }
    } catch {
      // non-fatal
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStats()
  }, [])

  // Settings normally decides, but COGNEE_ENABLED=false on the server is a kill
  // switch that overrides it (see cognee-core.ts). Surface that split state
  // instead of just saying "Disabled" and implying the toggle is stuck.
  const envBlocked = !!stats?.config?.enabled && !stats?.enabled

  const handleAction = async (action: string) => {
    setActionLoading(action)
    try {
      const res = await fetch('/api/cognee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success(
          action === 'reset' ? 'Cognee state reset' :
          action === 'forget_kb' ? 'Knowledge graph cleared' :
          `Re-cognify: ${data.data.processed ?? 0} processed, ${data.data.failed ?? 0} failed`,
        )
        await fetchStats()
      } else {
        toast.error(data.error || 'Action failed')
      }
    } catch {
      toast.error('Action failed')
    } finally {
      setActionLoading(null)
    }
  }

  const handleSaveConfig = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/cognee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_config',
          enabled: cfgEnabled,
          dbProvider: cfgProvider,
          dbUrl: cfgDbUrl,
          batchSize: cfgBatchSize,
          maxRetries: cfgMaxRetries,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success('Cognee configuration saved')
        setShowConfig(false)
        await fetchStats()
      } else {
        toast.error(data.error || 'Save failed')
      }
    } catch {
      toast.error('Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Delayed>
        <Card>
          <CardContent className="pt-4 space-y-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-40" />
          </CardContent>
        </Card>
      </Delayed>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm">Cognee Memory & Knowledge Graph</CardTitle>
          </div>
          <div className="flex items-center gap-1.5">
            {stats?.enabled ? (
              <>
                <Badge variant={stats.connected ? 'default' : 'destructive'} className="text-[10px]">
                  {stats.connected ? 'Connected' : 'Disconnected'}
                </Badge>
                <Badge variant="outline" className="text-[10px]">{stats.mode}</Badge>
              </>
            ) : envBlocked ? (
              <Badge variant="destructive" className="text-[10px]">Blocked by server config</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">Disabled</Badge>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              onClick={() => setShowConfig(!showConfig)}
            >
              {showConfig ? 'Hide' : 'Configure'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-2 space-y-3">
        {showConfig ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Enable Cognee</Label>
              <Switch
                checked={cfgEnabled}
                onCheckedChange={setCfgEnabled}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Database Backend</Label>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={cfgProvider === 'local' ? 'default' : 'outline'}
                  className="h-7 text-xs"
                  onClick={() => setCfgProvider('local')}
                >
                  Local (SQLite)
                </Button>
                <Button
                  size="sm"
                  variant={cfgProvider === 'postgres' ? 'default' : 'outline'}
                  className="h-7 text-xs"
                  onClick={() => setCfgProvider('postgres')}
                >
                  PostgreSQL
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                {cfgProvider === 'local'
                  ? 'Zero-config: SQLite + LanceDB + Kuzu. Best for dev and <100k documents.'
                  : 'Production: Postgres + pgvector. Scales to millions of documents.'}
              </p>
            </div>

            {cfgProvider === 'postgres' && (
              <div className="space-y-1">
                <Label className="text-xs">PostgreSQL Connection URL</Label>
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="postgresql://user:pass@host:5432/cognee"
                  value={cfgDbUrl}
                  onChange={(e) => setCfgDbUrl(e.target.value)}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Batch Size</Label>
                <Input
                  type="number"
                  className="h-8 text-xs"
                  min={1}
                  max={500}
                  value={cfgBatchSize}
                  onChange={(e) => setCfgBatchSize(parseInt(e.target.value) || 50)}
                />
                <p className="text-[10px] text-muted-foreground">Documents per cognify run</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Max Retries</Label>
                <Input
                  type="number"
                  className="h-8 text-xs"
                  min={0}
                  max={10}
                  value={cfgMaxRetries}
                  onChange={(e) => setCfgMaxRetries(parseInt(e.target.value) || 3)}
                />
                <p className="text-[10px] text-muted-foreground">On transient errors</p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-7 text-xs"
                icon={saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                onClick={handleSaveConfig}
                disabled={saving}
              >
                Save Configuration
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setShowConfig(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : stats?.enabled ? (
          <>
            <div className="grid grid-cols-4 gap-2">
              <div className="text-center">
                <div className="text-lg font-bold">{stats.documents.total}</div>
                <div className="text-[10px] text-muted-foreground">Total Docs</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-success">{stats.documents.cognified}</div>
                <div className="text-[10px] text-muted-foreground">Cognified</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-warning">{stats.documents.pending}</div>
                <div className="text-[10px] text-muted-foreground">Pending</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-destructive">{stats.documents.failed}</div>
                <div className="text-[10px] text-muted-foreground">Failed</div>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>Batch size: {stats.batchSize}</span>
              <span>·</span>
              <span>Max retries: {stats.maxRetries}</span>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                icon={actionLoading === 'recognify' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                onClick={() => handleAction('recognify')}
                disabled={actionLoading !== null}
              >
                Re-cognify All
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                icon={actionLoading === 'forget_kb' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                onClick={() => handleAction('forget_kb')}
                disabled={actionLoading !== null}
              >
                Clear Graph
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                icon={actionLoading === 'reset' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                onClick={() => handleAction('reset')}
                disabled={actionLoading !== null}
              >
                Full Reset
              </Button>
            </div>
          </>
        ) : envBlocked ? (
          <div className="flex items-start gap-2 text-xs text-muted-foreground py-2">
            <Brain className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Enabled in Configure, but the server runs with <code className="font-mono">COGNEE_ENABLED=false</code>,
              which force-disables memory. Remove that environment variable (or set it to <code className="font-mono">true</code>) and restart the server.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Brain className="h-3.5 w-3.5" />
            <span>Memory layer is disabled. Click "Configure" to enable.</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
