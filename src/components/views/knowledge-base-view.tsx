'use client'

/**
 * KnowledgeBaseView — RAG document management UI (spec §3.3).
 *
 * Lists uploaded documents with chunk counts + status, lets admins upload
 * new files (multipart/form-data), preview chunks, delete, and test the RAG
 * retrieval pipeline via /api/documents/search.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  UploadCloud,
  FileText,
  FileSpreadsheet,
  FileCode,
  File as FileIcon,
  Trash2,
  Eye,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Layers,
  FileStack,
  X,
  AlertTriangle,
  Database,
  Brain,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/view-states'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { DocumentItem } from '@/lib/types'
import { VECTOR_STORE_PRESETS, getVectorStorePreset } from '@/lib/db-provider-presets'
import { CogneeCard } from '@/components/views/cognee-card'
import { extractError } from '@/lib/extract-error'

/* ------------------------------------------------------------------ helpers */

const ACCEPTED = '.pdf,.docx,.xlsx,.txt,.md'
const MAX_BYTES = 50 * 1024 * 1024

function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function fileIconFor(type: string): {
  Icon: typeof FileText
  className: string
} {
  const t = (type || '').toLowerCase()
  if (t === 'pdf')
    return {
      Icon: FileText,
      className: 'bg-destructive/15 text-destructive',
    }
  if (t === 'docx' || t === 'doc')
    return {
      Icon: FileText,
      className: 'bg-info/15 text-info',
    }
  if (t === 'xlsx' || t === 'xls')
    return {
      Icon: FileSpreadsheet,
      className: 'bg-success/15 text-success',
    }
  if (t === 'md')
    return {
      Icon: FileCode,
      className: 'bg-muted text-muted-foreground',
    }
  return {
    Icon: FileIcon,
    className: 'bg-muted text-muted-foreground',
  }
}

const STATUS_BADGE: Record<
  string,
  { label: string; className: string }
> = {
  ready: {
    label: 'Ready',
    className: 'bg-success/15 text-success border-success/20',
  },
  processing: {
    label: 'Processing',
    className: 'bg-warning/15 text-warning border-warning/20',
  },
  error: {
    label: 'Error',
    className: 'bg-destructive/15 text-destructive border-destructive/20',
  },
}

function categoryColor(cat: string): string {
  const colors = [
    'bg-primary/15 text-primary border-primary/20',
    'bg-info/15 text-info border-info/20',
    'bg-warning/15 text-warning border-warning/20',
    'bg-success/15 text-success border-success/20',
    'bg-chart-4/15 text-chart-4 border-chart-4/20',
    'bg-chart-5/15 text-chart-5 border-chart-5/20',
  ]
  let hash = 0
  for (let i = 0; i < cat.length; i++) hash = (hash * 31 + cat.charCodeAt(i)) | 0
  return colors[Math.abs(hash) % colors.length]
}

/* ------------------------------------------------------------------- types */

interface ChunkPreview {
  id: string
  chunkIndex: number
  content: string
  tokenCount: number
  keywords: string | null
}

interface DocDetail extends DocumentItem {
  contentText?: string
  chunkPreview: ChunkPreview[]
}

/* ============================================================ main view */

export function KnowledgeBaseView() {
  const [docs, setDocs] = useState<DocumentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [activeCat, setActiveCat] = useState<string>('ALL')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [detailTarget, setDetailTarget] = useState<DocumentItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DocumentItem | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [, setRebuildingEmbeddings] = useState(false)
  const [, setRebuildingFts] = useState(false)

  const fetchDocs = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const res = await fetch('/api/documents', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok && Array.isArray(json.documents)) {
        setDocs(json.documents as DocumentItem[])
      } else {
        setLoadError(true)
        toast.error(extractError(json.error, 'Failed to load document list.'))
      }
    } catch (e) {
      setLoadError(true)
      toast.error('Network error while loading documents.')
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDocs()
  }, [fetchDocs])

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if ((res.ok && json.ok) || res.status === 404) {
        toast.success(
          res.status === 404
            ? 'Document no longer exists. List reloaded.'
            : `Document deleted. ${json.chunkCountRemoved ?? 0} chunks also deleted.`,
        )
        if (detailTarget?.id === id) setDetailTarget(null)
        await fetchDocs()
      } else {
        toast.error(extractError(json.error, 'Failed to delete document.'))
      }
    } catch (e) {
      toast.error('Network error while deleting.')
      console.error(e)
    } finally {
      setDeleteTarget(null)
      setDeletingId(null)
    }
  }

  const handleToggleDoc = async (id: string, checked: boolean) => {
    // Optimistic update
    setDocs((prev) =>
      prev.map((d) => (d.id === id ? { ...d, isEnabled: checked } : d)),
    )
    try {
      const res = await fetch(`/api/documents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: checked }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        // Revert on failure
        setDocs((prev) =>
          prev.map((d) => (d.id === id ? { ...d, isEnabled: !checked } : d)),
        )
        toast.error(extractError(json.error, 'Failed to change document status.'))
        return
      }
      toast.success(
        checked
          ? 'Document enabled for RAG.'
          : 'Document disabled from RAG.',
      )
    } catch (e) {
      // Revert on error
      setDocs((prev) =>
        prev.map((d) => (d.id === id ? { ...d, isEnabled: !checked } : d)),
      )
      toast.error('Network error while changing status.')
      console.error(e)
    }
  }

  const rebuildEmbeddings = async () => {
    setRebuildingEmbeddings(true)
    try {
      const res = await fetch('/api/documents/embeddings/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(extractError(json.error, 'Failed to rebuild embeddings.'))
      }
      toast.success('Embeddings processed.', {
        description: `${json.data.embedded ?? 0} chunks embedded, ${json.data.skipped ?? 0} skipped.`,
      })
      await fetchDocs()
    } catch (e) {
      toast.error('Failed to rebuild embeddings', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setRebuildingEmbeddings(false)
    }
  }

  const rebuildFts = async () => {
    setRebuildingFts(true)
    try {
      const res = await fetch('/api/documents/fts/rebuild', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to rebuild FTS.'))
      toast.success('BM25 index processed.', {
        description: `${json.data.indexed ?? 0} chunks added to lexical index.`,
      })
    } catch (e) {
      toast.error('Failed to rebuild FTS', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setRebuildingFts(false)
    }
  }

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { action?: string } | undefined
      if (detail?.action === 'rebuild-embeddings') void rebuildEmbeddings()
      if (detail?.action === 'rebuild-bm25') void rebuildFts()
    }
    window.addEventListener('view-action', handler)
    return () => window.removeEventListener('view-action', handler)
  }, [rebuildEmbeddings, rebuildFts])

  // Stats
  const totalChunks = docs.reduce((s, d) => s + (d.chunkCount ?? 0), 0)
  const readyCount = docs.filter((d) => d.status === 'ready').length
  const errorCount = docs.filter((d) => d.status !== 'ready').length

  const DOCS_PER_PAGE = 12
  const [docPage, setDocPage] = useState(1)
  const filteredDocs = activeCat === 'ALL' ? docs : docs.filter((d) => (d.category ?? 'Uncategorized') === activeCat)
  const docTotalPages = Math.max(1, Math.ceil(filteredDocs.length / DOCS_PER_PAGE))
  const pagedDocs = filteredDocs.slice((docPage - 1) * DOCS_PER_PAGE, docPage * DOCS_PER_PAGE)
  useEffect(() => { setDocPage(1) }, [activeCat])

  // Dynamic categories from existing documents
  const existingCategories = Array.from(new Set(docs.map((d) => d.category ?? 'Uncategorized').filter(Boolean))).sort()
  const catCounts: Record<string, number> = {}
  for (const d of docs) {
    const c = d.category ?? 'Uncategorized'
    catCounts[c] = (catCounts[c] ?? 0) + 1
  }

  return (
    <div className="space-y-3">
      {/* Stats row — always visible */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <StatCard label="Total Documents" value={docs.length} icon={FileStack} iconClass="text-muted-foreground" />
        <StatCard label="Total Chunks" value={totalChunks} icon={Layers} iconClass="text-primary" />
        <StatCard label="Ready" value={readyCount} icon={CheckCircle2} iconClass="text-success" />
        <StatCard label="Error / Processing" value={errorCount} icon={AlertCircle} iconClass="text-destructive" />
      </div>

      <Tabs defaultValue="documents">
        <div className="flex items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="documents" className="gap-1.5 text-xs">
              <FileText className="h-3.5 w-3.5" />
              Documents
            </TabsTrigger>
            <TabsTrigger value="vector" className="gap-1.5 text-xs">
              <Database className="h-3.5 w-3.5" />
              Vector Store
            </TabsTrigger>
            <TabsTrigger value="cognee" className="gap-1.5 text-xs">
              <Brain className="h-3.5 w-3.5" />
              AI Memory
            </TabsTrigger>
          </TabsList>
          <div className="flex gap-1.5">
            <Button onClick={() => setUploadOpen(true)} size="sm">
              <UploadCloud className="h-3.5 w-3.5" />
              Upload
            </Button>
          </div>
        </div>

        <TabsContent value="documents" className="mt-2 space-y-3">
          {/* Category filter */}
          <div className="flex flex-wrap items-center gap-1.5">
        <CatTab
          active={activeCat === 'ALL'}
          onClick={() => setActiveCat('ALL')}
          label="All"
          count={docs.length}
        />
        {existingCategories.map((c) => (
          <CatTab
            key={c}
            active={activeCat === c}
            onClick={() => setActiveCat(c)}
            label={c}
            count={catCounts[c] ?? 0}
          />
        ))}
      </div>

      {/* Document list */}
      {loading ? (
        <LoadingState label="Loading documents…" />
      ) : loadError ? (
        <ErrorState message="Failed to load documents." onRetry={fetchDocs} />
      ) : docs.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={FileText}
              title={
                activeCat === 'ALL'
                  ? 'No documents yet'
                  : `No documents in the ${activeCat} category`
              }
              hint={activeCat === 'ALL' ? 'Click Upload Document to add files to the knowledge base.' : undefined}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {pagedDocs.map((d) => (
              <DocCard
                key={d.id}
                doc={d}
                deleting={deletingId === d.id}
                onDetail={() => setDetailTarget(d)}
                onDelete={() => setDeleteTarget(d)}
                onToggle={(checked) => handleToggleDoc(d.id, checked)}
              />
            ))}
          </div>
          {docTotalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2 text-xs text-muted-foreground">
              <Button size="sm" variant="outline" disabled={docPage <= 1} onClick={() => setDocPage(docPage - 1)} className="h-7">
                Previous
              </Button>
              <span>Page {docPage} of {docTotalPages}</span>
              <Button size="sm" variant="outline" disabled={docPage >= docTotalPages} onClick={() => setDocPage(docPage + 1)} className="h-7">
                Next
              </Button>
            </div>
          )}
        </>
      )}

        </TabsContent>

        <TabsContent value="vector" className="mt-2">
          <VectorStorePanel />
        </TabsContent>

        <TabsContent value="cognee" className="mt-2">
          <CogneeCard />
        </TabsContent>
      </Tabs>

      {/* Upload dialog */}
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        existingCategories={existingCategories}
        onUploaded={() => {
          setUploadOpen(false)
          fetchDocs()
        }}
      />

      {/* Detail dialog */}
      <DocDetailDialog
        doc={detailTarget}
        onClose={() => setDetailTarget(null)}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              Document <strong>{deleteTarget?.name}</strong> and its{' '}
              {deleteTarget?.chunkCount ?? 0} chunks will be permanently deleted.
              This action is recorded in the audit log.
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

function VectorStorePanel() {
  const [provider, setProvider] = useState('INTERNAL')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [collectionName, setCollectionName] = useState('ryasai_chunks')
  const [vectorSize, setVectorSize] = useState('1536')
  const [distance, setDistance] = useState('Cosine')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const vsPreset = getVectorStorePreset(provider)
  const vsBackend = vsPreset?.backend ?? provider
  const isInternal = vsBackend === 'INTERNAL'
  const needsApiKey = vsPreset?.needsApiKey ?? false

  const handleProviderChange = (id: string) => {
    const p = getVectorStorePreset(id)
    setProvider(id)
    if (p) {
      setVectorSize(String(p.defaultVectorSize))
      if (p.baseUrlPlaceholder && !baseUrl) setBaseUrl(p.baseUrlPlaceholder)
    }
  }

  useEffect(() => {
    let cancelled = false
    fetch('/api/vector-store', { cache: 'no-store' })
      .then((res) => res.json())
      .then((json) => {
        if (cancelled || !json.ok || !json.data) return
        setProvider(json.data.provider ?? 'INTERNAL')
        setBaseUrl(json.data.baseUrl ?? '')
        setCollectionName(json.data.collectionName ?? 'ryasai_chunks')
        setVectorSize(String(json.data.vectorSize ?? 1536))
        setDistance(json.data.distance ?? 'Cosine')
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    if (needsApiKey && !apiKey.trim()) {
      toast.error('API key required for this provider.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/vector-store', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          baseUrl,
          apiKey: apiKey || undefined,
          collectionName,
          vectorSize: Number(vectorSize) || 1536,
          distance,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to save.'))
      setApiKey('')
      toast.success('Vector DB configuration saved.')
    } catch (e) {
      toast.error('Failed to save vector DB', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const res = await fetch('/api/vector-store', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to test vector DB.'))
      toast.success('Vector DB ready.', {
        description: json.data?.collectionName ?? json.data?.provider,
      })
    } catch (e) {
      toast.error('Vector DB not ready', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <Layers className="h-4.5 w-4.5" />
          </div>
          <div>
            <CardTitle className="text-xs">Vector DB</CardTitle>
            <p className="text-xs text-muted-foreground">
              Qdrant/Milvus for external semantic retrieval. Internal remains as fallback.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        {loadError && (
          <div className="md:col-span-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="text-xs text-destructive">
              Failed to load vector DB configuration. Saving may overwrite existing configuration. Reload the page to try again.
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <Label>Provider</Label>
          <Select value={provider} onValueChange={handleProviderChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VECTOR_STORE_PRESETS.map(p => (
                <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {vsPreset?.hint && (
            <p className="text-xs text-warning">{vsPreset.hint}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>Base URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={vsPreset?.baseUrlPlaceholder ?? ''}
            className="font-mono text-sm"
            disabled={isInternal}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Collection</Label>
          <Input
            value={collectionName}
            onChange={(e) => setCollectionName(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label>Dimension</Label>
            <Input
              value={vectorSize}
              onChange={(e) => setVectorSize(e.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Distance</Label>
            <Input value={distance} onChange={(e) => setDistance(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label>
            API Key{needsApiKey && <span className="text-destructive"> *</span>}
          </Label>
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={needsApiKey ? 'required' : 'optional'}
            className="font-mono text-sm"
            autoComplete="new-password"
          />
        </div>
        <div className="flex justify-end gap-2 md:col-span-2">
          <Button variant="outline" onClick={test} disabled={testing || isInternal}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Test
          </Button>
          <Button onClick={save} disabled={saving || loadError}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------- stat card */

function StatCard({
  label,
  value,
  icon: Icon,
  iconClass,
}: {
  label: string
  value: number
  icon: typeof FileStack
  iconClass: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">{value}</div>
          <div className="text-xs text-muted-foreground truncate">{label}</div>
        </div>
        <Icon className={cn('h-4 w-4 shrink-0', iconClass)} />
      </CardContent>
    </Card>
  )
}

/* ----------------------------------------------------------- category tab */

function CatTab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-background hover:bg-muted text-muted-foreground border-border',
      )}
    >
      {label}
      <span
        className={cn(
          'text-xs rounded-full px-1.5 py-0.5',
          active
            ? 'bg-primary-foreground/20 text-primary-foreground'
            : 'bg-muted text-muted-foreground',
        )}
      >
        {count}
      </span>
    </button>
  )
}

/* ----------------------------------------------------------- doc card */

function DocCard({
  doc,
  deleting,
  onDetail,
  onDelete,
  onToggle,
}: {
  doc: DocumentItem
  deleting?: boolean
  onDetail: () => void
  onDelete: () => void
  onToggle: (checked: boolean) => void
}) {
  const [toggling, setToggling] = useState(false)
  const { Icon, className: iconCls } = fileIconFor(doc.type)
  const status = STATUS_BADGE[doc.status] ?? STATUS_BADGE.error
  const catBadge = categoryColor(doc.category ?? 'Uncategorized')
  const isEnabled = doc.isEnabled !== false

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              'h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
              iconCls,
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-xs leading-snug break-words line-clamp-1">
              {doc.name}
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={cn('text-[10px]', catBadge)}>
                {doc.category ?? 'Uncategorized'}
              </Badge>
              <Badge variant="outline" className={cn('text-[10px]', status.className)}>
                {status.label}
              </Badge>
              {doc.cognifyStatus && (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px]',
                    doc.cognifyStatus === 'completed' && 'bg-primary/15 text-primary border-primary/20',
                    doc.cognifyStatus === 'processing' && 'bg-warning/15 text-warning border-warning/20',
                    doc.cognifyStatus === 'failed' && 'bg-destructive/15 text-destructive border-destructive/20',
                  )}
                >
                  {doc.cognifyStatus === 'completed' ? 'Graph' : doc.cognifyStatus}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-medium text-muted-foreground">
              {isEnabled ? 'ON' : 'OFF'}
            </span>
            <Switch
              checked={isEnabled}
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

      <CardContent className="flex-1 flex flex-col gap-2 pt-0">
        <div className="mt-auto grid grid-cols-2 gap-2">
          <Button size="sm" variant="outline" onClick={onDetail} className="text-xs h-7">
            <Eye className="h-3 w-3" />
            Details
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            {deleting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            {deleting ? 'Deleting' : 'Delete'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/* ----------------------------------------------------------- upload dialog */

function UploadDialog({
  open,
  onOpenChange,
  onUploaded,
  existingCategories,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onUploaded: () => void
  existingCategories: string[]
}) {
  const [file, setFile] = useState<File | null>(null)
  const [category, setCategory] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setFile(null)
    setCategory('')
    setDescription('')
    setSizeError(null)
    setDragOver(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const pickFile = (f: File | null | undefined) => {
    if (!f) return
    if (f.size > MAX_BYTES) {
      setSizeError(
        `File size ${formatSize(f.size)} exceeds the 50 MB limit (spec §8).`,
      )
      setFile(null)
      return
    }
    if (f.size <= 0) {
      setSizeError('File is empty.')
      setFile(null)
      return
    }
    setSizeError(null)
    setFile(f)
  }

  const handleSubmit = async () => {
    if (!file) {
      toast.error('Please select a file first.')
      return
    }
    if (sizeError) {
      toast.error(sizeError)
      return
    }
    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('category', category.trim() || 'Uncategorized')
      fd.append('description', description)
      const res = await fetch('/api/documents', { method: 'POST', body: fd })
      const json = await res.json()
      if (res.ok && json.document) {
        toast.success('Document uploaded & processed.')
        reset()
        onUploaded()
      } else if (res.status === 413) {
        setSizeError(
          `File exceeds 50 MB (spec §8). Size: ${formatSize(
            json.sizeBytes ?? file.size,
          )}.`,
        )
      } else {
        toast.error(extractError(json.error, 'Failed to upload document.'))
      }
    } catch (e) {
      toast.error('Network error while uploading.')
      console.error(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!submitting) {
          onOpenChange(o)
          if (!o) reset()
        }
      }}
    >
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Document</DialogTitle>
          <DialogDescription>
            Supports PDF, DOCX, XLSX, TXT, MD. Max 50 MB. Files are automatically
            chunked for RAG retrieval.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Drag & drop area */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              pickFile(e.dataTransfer.files?.[0])
            }}
            onClick={() => inputRef.current?.click()}
            className={cn(
              'cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-colors',
              dragOver
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/50 hover:bg-muted/40',
            )}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              className="sr-only"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            {file ? (
              <div className="flex items-center justify-center gap-2">
                {(() => {
                  const { Icon, className: cls } = fileIconFor(
                    file.name.split('.').pop() ?? '',
                  )
                  return (
                    <div
                      className={cn(
                        'h-9 w-9 rounded-md flex items-center justify-center',
                        cls,
                      )}
                    >
                      <Icon className="h-4.5 w-4.5" />
                    </div>
                  )
                })()}
                <div className="text-left min-w-0">
                  <div className="text-sm font-medium truncate max-w-[280px]">
                    {file.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatSize(file.size)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setFile(null)
                    if (inputRef.current) inputRef.current.value = ''
                  }}
                  className="ml-1 p-1 rounded hover:bg-muted"
                  aria-label="Remove file selection"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <>
                <UploadCloud className="h-8 w-8 mx-auto text-muted-foreground/60 mb-2" />
                <p className="text-sm font-medium">
                  Drag a file here or click to select
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  PDF, DOCX, XLSX, TXT, MD · max 50 MB
                </p>
              </>
            )}
          </div>

          {sizeError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{sizeError}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="doc-cat">Category</Label>
            <Input
              id="doc-cat"
              list="category-suggestions"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Type or select a category (e.g. SOP, Finance, HR)"
              className="text-xs"
            />
            <datalist id="category-suggestions">
              {existingCategories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <p className="text-[10px] text-muted-foreground">
              Custom category — type anything. Existing categories appear as suggestions.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="doc-desc">Description (optional)</Label>
            <Textarea
              id="doc-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Brief summary of the document content…"
              className="resize-none"
            />
          </div>
        </div>

          {submitting && file && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Uploading {file.name}...
            </div>
          )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !file}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Processing &amp; chunking…
              </>
            ) : (
              <>
                <UploadCloud className="h-4 w-4" />
                Upload
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------ detail dialog */

function DocDetailDialog({
  doc,
  onClose,
}: {
  doc: DocumentItem | null
  onClose: () => void
}) {
  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[680px] max-h-[92vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <FileText className="h-4 w-4 shrink-0" />
            <span className="truncate">{doc?.name ?? ''}</span>
          </DialogTitle>
          <DialogDescription>
            Document details + chunk preview. Load more chunks via pagination.
          </DialogDescription>
        </DialogHeader>
        {doc && <DocDetailContent key={doc.id} doc={doc} />}
      </DialogContent>
    </Dialog>
  )
}

function DocDetailContent({ doc }: { doc: DocumentItem }) {
  const [detail, setDetail] = useState<DocDetail | null>(null)
  const [extraChunks, setExtraChunks] = useState<ChunkPreview[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(doc.chunkCount)
  const [loadingChunks, setLoadingChunks] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/documents/${doc.id}`, { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json()
        if (cancelled) return
        if (r.ok && j.document) {
          setDetail(j.document as DocDetail)
          setTotal(j.document.chunkCount ?? doc.chunkCount)
          setTotalPages(
            Math.max(1, Math.ceil((j.document.chunkCount ?? 0) / 20)),
          )
        } else {
          setError(extractError(j.error, 'Failed to load document details.'))
        }
      })
      .catch(() => {
        if (!cancelled) setError('Network error.')
      })
      .finally(() => !cancelled && setLoadingChunks(false))
    return () => {
      cancelled = true
    }
  }, [doc.id])

  const loadMore = async () => {
    const nextPage = page + 1
    setLoadingMore(true)
    try {
      const res = await fetch(
        `/api/documents/${doc.id}/chunks?page=${nextPage}&pageSize=20`,
        { cache: 'no-store' },
      )
      const j = await res.json()
      if (res.ok && Array.isArray(j.chunks)) {
        setExtraChunks((prev) => [...prev, ...(j.chunks as ChunkPreview[])])
        setPage(nextPage)
        setTotalPages(j.totalPages ?? totalPages)
      } else {
        toast.error(extractError(j.error, 'Failed to load chunks.'))
      }
    } catch {
      toast.error('Network error while loading chunks.')
    } finally {
      setLoadingMore(false)
    }
  }

  if (loadingChunks && !detail) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading details…
      </div>
    )
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (!detail) return null

  const preview = detail.chunkPreview ?? []
  const allChunks = [...preview, ...extraChunks]
  const hasMore = page < totalPages

  return (
    <div className="space-y-3 min-h-0 flex-1 overflow-y-auto pr-1">
      {/* meta */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Meta label="Category" value={detail.category ?? 'Uncategorized'} />
        <Meta label="Type" value={detail.type} />
        <Meta label="Size" value={formatSize(detail.sizeBytes)} />
        <Meta label="Status" value={detail.status} />
      </div>

      {detail.description && (
        <p className="text-xs text-muted-foreground italic">
          “{detail.description}”
        </p>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {total} chunks total · showing {allChunks.length}
        </div>
      </div>

      {/* chunk list */}
      <div className="space-y-2">
        {allChunks.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No chunks available.
          </p>
        ) : (
          allChunks.map((c, i) => (
            <ChunkCard key={c.id ?? i} chunk={c} />
          ))
        )}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading…
              </>
            ) : (
              <>
                <Layers className="h-3.5 w-3.5" />
                Load more chunks (page {page + 1}/{totalPages})
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div className="text-sm font-medium truncate">{value}</div>
    </div>
  )
}

function ChunkCard({ chunk }: { chunk: ChunkPreview }) {
  const [expanded, setExpanded] = useState(false)
  const preview = chunk.content.length > 280
    ? chunk.content.slice(0, 280) + '…'
    : chunk.content
  const keywords = (chunk.keywords ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-xs">
            #{chunk.chunkIndex}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {chunk.tokenCount} tokens
          </span>
        </div>
        {chunk.content.length > 280 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-primary hover:underline"
          >
            {expanded ? 'Collapse' : 'Show full'}
          </button>
        )}
      </div>
      <p className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80">
        {expanded ? chunk.content : preview}
      </p>
      {keywords.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {keywords.slice(0, 8).map((k, i) => (
            <span
              key={i}
              className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
            >
              {k}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

