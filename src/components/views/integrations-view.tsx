'use client'

/**
 * IntegrationsView — Dynamic Connector Factory UI (spec §3.1, §3.2, §5.1).
 *
 * Admins register SQL databases and REST API connectors here. Database
 * integrations expose schema reflection and a Text-to-SQL query tester.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Database,
  Globe,
  Plus,
  RefreshCw,
  Eye,
  CheckCircle2,
  XCircle,
  Loader2,
  Server,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { CardGridSkeleton, ListRowsSkeleton, EmptyState, ErrorState } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
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
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { extractError } from '@/lib/extract-error'
import type { Integration } from '@/lib/types'
import type { RestConnectorItem } from './integrations/types'
import { StatCard } from './integrations/stat-card'
import { IntegrationCard } from './integrations/integration-card'
import { CreateIntegrationDialog } from './integrations/create-integration-dialog'
import { SchemaViewerSheet } from './integrations/schema-viewer'
import { RestConnectorSheet } from './integrations/rest-connector-sheet'
import { QueryTesterDialog } from './integrations/query-tester'
import { RestCreateForm } from './integrations/rest-create-form'

/* ============================================================ main view */

export function IntegrationsView() {
  const [items, setItems] = useState<Integration[]>([])
  const [restItems, setRestItems] = useState<RestConnectorItem[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [restLoading, setRestLoading] = useState(true)
  const showRestSkeleton = useDelayedLoading(restLoading)
  const [loadError, setLoadError] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'database' | 'rest'>('database')
  const [testingId, setTestingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Integration | null>(null)
  const [schemaTarget, setSchemaTarget] = useState<Integration | null>(null)
  const [queryTarget, setQueryTarget] = useState<Integration | null>(null)
  const [restTarget, setRestTarget] = useState<RestConnectorItem | null>(null)

  const fetchList = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const res = await fetch('/api/integrations', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok && json.ok) {
        setItems(json.data as Integration[])
      } else {
        setLoadError(true)
        toast.error(extractError(json.error, 'Failed to load integration list.'))
      }
    } catch (e) {
      setLoadError(true)
      toast.error('Network error while loading integrations.')
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  const fetchRestList = useCallback(async () => {
    setRestLoading(true)
    try {
      const res = await fetch('/api/data-sources/rest-connectors', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok && json.ok) {
        setRestItems(json.items ?? [])
      } else {
        toast.error(extractError(json.error, 'Failed to load REST API connectors.'))
      }
    } catch (e) {
      toast.error('Network error while loading REST API connectors.')
      console.error(e)
    } finally {
      setRestLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRestList()
  }, [fetchRestList])

  const handleTest = async (id: string) => {
    setTestingId(id)
    try {
      const res = await fetch(`/api/integrations/${id}/test`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        toast.error(extractError(json.error, 'Failed to test connection.'))
      } else if (json.ok) {
        toast.success(
          `Connection successful. ${json.tablesCount ?? 0} tables available.`,
        )
        await fetchList()
      } else {
        toast.error(json.message ?? 'Connection failed — check credentials.')
        await fetchList()
      }
    } catch (e) {
      toast.error('Network error while testing connection.')
      console.error(e)
    } finally {
      setTestingId(null)
    }
  }

  const handleToggleIntegration = async (id: string, checked: boolean) => {
    const newStatus = checked ? 'active' : 'inactive'
    try {
      const res = await fetch(`/api/integrations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        toast.error(extractError(json.error, 'Failed to change integration status.'))
        return
      }
      toast.success(
        checked
          ? 'Integration enabled.'
          : 'Integration disabled.',
      )
      await fetchList()
    } catch (e) {
      toast.error('Network error while changing status.')
      console.error(e)
    }
  }

  const handleToggleRestConnector = async (id: string, checked: boolean) => {
    try {
      const res = await fetch(`/api/data-sources/rest-connectors/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: checked }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        toast.error(extractError(json.error, 'Failed to change REST connector status.'))
        return
      }
      toast.success(
        checked
          ? 'REST connector enabled.'
          : 'REST connector disabled.',
      )
      await fetchRestList()
    } catch (e) {
      toast.error('Network error while changing status.')
      console.error(e)
    }
  }

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      const res = await fetch(`/api/integrations/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if ((res.ok && json.ok) || res.status === 404) {
        toast.success(
          res.status === 404
            ? 'Integration no longer exists. List reloaded.'
            : 'Integration deleted successfully.',
        )
        if (schemaTarget?.id === id) setSchemaTarget(null)
        if (queryTarget?.id === id) setQueryTarget(null)
        await fetchList()
      } else {
        toast.error(extractError(json.error, 'Failed to delete integration.'))
      }
    } catch (e) {
      toast.error('Network error while deleting.')
      console.error(e)
    } finally {
      setDeleteTarget(null)
      setDeletingId(null)
    }
  }

  const stats = {
    total: items.length,
    active: items.filter((i) => i.status === 'active').length,
    errorInactive: items.filter((i) => i.status !== 'active').length,
  }

  return (
    <div className="space-y-3">
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2.5">
        <StatCard
          label="Total Databases"
          value={stats.total}
          icon={Server}
          iconClass="text-muted-foreground"
        />
        <StatCard
          label="Active"
          value={stats.active}
          icon={CheckCircle2}
          iconClass="text-success"
        />
        <StatCard
          label="Error / Inactive"
          value={stats.errorInactive}
          icon={XCircle}
          iconClass="text-destructive"
        />
      </div>

      <Tabs defaultValue="database" onValueChange={(v) => setActiveTab(v as 'database' | 'rest')} className="min-h-[500px]">
        <div className="flex items-center justify-between gap-2">
          <TabsList className="w-max">
            <TabsTrigger value="database" className="gap-1.5 text-xs">
              <Server className="h-3.5 w-3.5" />
              Database
            </TabsTrigger>
            <TabsTrigger value="rest" className="gap-1.5 text-xs">
              <Globe className="h-3.5 w-3.5" />
              REST API
            </TabsTrigger>
          </TabsList>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" onClick={fetchList} disabled={loading}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
            {activeTab === 'database' && (
              <Button onClick={() => setCreateOpen(true)} size="sm">
                <Plus className="h-3.5 w-3.5" />
                Add Database
              </Button>
            )}
          </div>
        </div>

        <TabsContent value="database" className="mt-2">
      {/* ponytail: gate on `loading` — otherwise the first 200 ms falls through
          to the empty state and the view paints empty → skeleton → cards. */}
      {loading ? (
        showSkeleton ? <CardGridSkeleton /> : null
      ) : loadError ? (
        <ErrorState message="Failed to load integrations." onRetry={fetchList} />
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Database}
              title="No databases registered yet"
              hint="Click Add Database to start connecting SQL data sources."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {items.map((it) => (
            <IntegrationCard
              key={it.id}
              integration={it}
              onTest={() => handleTest(it.id)}
              testing={testingId === it.id}
              deleting={deletingId === it.id}
              onSchema={() => setSchemaTarget(it)}
              onQuery={() => setQueryTarget(it)}
              onDelete={() => setDeleteTarget(it)}
              onToggle={(checked) => handleToggleIntegration(it.id, checked)}
            />
          ))}
        </div>
      )}
        </TabsContent>

        <TabsContent value="rest" className="mt-2">
      {/* REST API Connectors */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xs flex items-center gap-2">
            <Globe className="h-4 w-4" />
            REST API Connectors
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Register the base URL of an external system, then whitelist endpoints that can be called by the chatbot.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <RestCreateForm onCreated={fetchRestList} />

          {showRestSkeleton ? (
            <ListRowsSkeleton count={3} />
          ) : restItems.length === 0 ? (
            <div className="rounded-md border border-dashed py-8 text-center text-xs text-muted-foreground">
              No REST API connectors yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {restItems.map((connector) => (
                <div key={connector.id} className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{connector.name}</div>
                      <div className="font-mono text-xs text-muted-foreground truncate">
                        {connector.baseUrl}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs font-medium text-muted-foreground">
                        {connector.isActive ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                      <Switch
                        checked={connector.isActive}
                        onCheckedChange={(checked) =>
                          handleToggleRestConnector(connector.id, checked)
                        }
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{connector.authType}</Badge>
                    <Badge variant="outline">{connector._count?.endpoints ?? 0} endpoint</Badge>
                    <Badge variant="outline">{connector._count?.requestLogs ?? 0} request log</Badge>
                    <Badge variant="outline">{connector.timeoutMs}ms timeout</Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRestTarget(connector)}
                    className="w-full"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Manage Endpoints
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>

      {/* Create dialog */}
      <CreateIntegrationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false)
          fetchList()
        }}
      />

      {/* Schema viewer */}
      <SchemaViewerSheet
        integration={schemaTarget}
        onClose={() => setSchemaTarget(null)}
      />

      <RestConnectorSheet
        connector={restTarget}
        onClose={() => setRestTarget(null)}
        onChanged={fetchRestList}
      />

      {/* Query tester */}
      <QueryTesterDialog
        integration={queryTarget}
        onClose={() => setQueryTarget(null)}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this integration?</AlertDialogTitle>
            <AlertDialogDescription>
              Integration <strong>{deleteTarget?.name}</strong> will be permanently
              deleted along with its reflected schema. This action cannot be
              undone and is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && handleDelete(deleteTarget.id)}
              disabled={!!deletingId}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {deletingId ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
