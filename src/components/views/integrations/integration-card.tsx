'use client'

import { useState } from 'react'
import {
  Database,
  Globe,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  RefreshCw,
  Eye,
  Terminal,
  Trash2,
  Table2,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { extractError } from '@/lib/extract-error'
import type { Integration } from '@/lib/types'
import { MaskedConfig, STATUS_BADGE, timeAgo } from './types'

export function IntegrationCard({
  integration,
  onTest,
  testing,
  onInitContext,
  initContexting,
  deleting,
  onSchema,
  onQuery,
  onDelete,
  onToggle,
}: {
  integration: Integration
  onTest: () => void
  testing: boolean
  onInitContext?: () => void
  initContexting?: boolean
  deleting?: boolean
  onSchema: () => void
  onQuery: () => void
  onDelete: () => void
  onToggle: (checked: boolean) => void
}) {
  const [configOpen, setConfigOpen] = useState(false)
  const [config, setConfig] = useState<MaskedConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [toggling, setToggling] = useState(false)

  const fetchConfig = async () => {
    setConfigLoading(true)
    try {
      const res = await fetch(`/api/integrations/${integration.id}`, {
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok && json.ok) {
        setConfig(json.data.config as MaskedConfig)
      } else {
        toast.error(extractError(json.error, 'Failed to load configuration.'))
      }
    } catch {
      toast.error('Network error while loading configuration.')
    } finally {
      setConfigLoading(false)
    }
  }

  const isDb = integration.type === 'DATABASE'
  const Icon = isDb ? Database : Globe
  const status = STATUS_BADGE[integration.status] ?? STATUS_BADGE.error
  const lastOk = integration.lastTestOk
  const isActive = integration.status === 'active'

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-xs truncate">{integration.name}</CardTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="text-xs">
                {integration.provider}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {integration.type}
              </Badge>
              <Badge variant="outline" className={cn('text-xs', status.className)}>
                {status.label}
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">
                {isActive ? 'ACTIVE' : 'INACTIVE'}
              </span>
            </div>
            <Switch
              checked={isActive}
              disabled={toggling}
              onCheckedChange={async (checked) => {
                setToggling(true)
                try {
                  await onToggle(checked)
                } finally {
                  setToggling(false)
                }
              }}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-3">
        {/* meta row */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>Last tested:</span>
          </div>
          <div className="flex items-center gap-1.5 justify-end">
            {lastOk === true && (
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            )}
            {lastOk === false && (
              <XCircle className="h-3.5 w-3.5 text-destructive" />
            )}
            <span className="text-muted-foreground truncate">
              {timeAgo(integration.lastTestedAt)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Table2 className="h-3.5 w-3.5" />
            <span>Indexed tables:</span>
          </div>
          <div className="text-right font-medium">
            {integration.tableCount ?? 0} tables
          </div>
        </div>

        {/* masked config collapsible */}
        <details
          className="group rounded-md border bg-muted/30 px-3 py-2 text-xs"
          onToggle={(e) => {
            if ((e.currentTarget as HTMLDetailsElement).open) fetchConfig()
            setConfigOpen((e.currentTarget as HTMLDetailsElement).open)
          }}
        >
          <summary className="cursor-pointer flex items-center justify-between text-muted-foreground hover:text-foreground transition-colors select-none">
            <span className="font-medium">Configuration (encrypted)</span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                configOpen && 'rotate-180',
              )}
            />
          </summary>
          <div className="mt-2 space-y-1">
            {configLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading…
              </div>
            ) : config ? (
              <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">Host</span>
                <span className="font-mono truncate">{String(config.host ?? '-')}</span>
                <span className="text-muted-foreground">Port</span>
                <span className="font-mono truncate">{String(config.port ?? '-')}</span>
                <span className="text-muted-foreground">Database</span>
                <span className="font-mono truncate">{String(config.database_name ?? '-')}</span>
                <span className="text-muted-foreground">Username</span>
                <span className="font-mono truncate">{String(config.username ?? '-')}</span>
                <span className="text-muted-foreground">Password</span>
                <span className="font-mono">••••••••</span>
              </div>
            ) : (
              <div className="text-muted-foreground">Not loaded yet.</div>
            )}
          </div>
        </details>

        {/* action buttons */}
        <div className="mt-auto grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={onTest}
            disabled={testing}
            className="text-xs"
            icon={
              testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )
            }
          >
            Test Connection
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onInitContext}
            disabled={initContexting}
            className="text-xs"
            title="Generate business context (domain, glossary, query hints) for better SQL generation"
            icon={
              initContexting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )
            }
          >
            Init Context
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onSchema}
            className="text-xs"
            icon={<Eye className="h-3.5 w-3.5" />}
          >
            Schema
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onQuery}
            className="text-xs"
            icon={<Terminal className="h-3.5 w-3.5" />}
          >
            Query
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
            icon={
              deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )
            }
          >
            {deleting ? 'Deleting' : 'Delete'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
