'use client'

/**
 * KnowledgeBaseView — RAG document management UI (spec §3.3).
 *
 * Lists uploaded documents with chunk counts + status, lets admins upload
 * new files (multipart/form-data), preview chunks, delete, and test the RAG
 * retrieval pipeline via /api/documents/search.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  UploadCloud,
  FileText,
  FileStack,
  Layers,
  CheckCircle2,
  AlertCircle,
  Database,
  Brain,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/view-states'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import type { DocumentItem } from '@/lib/types'
import { CogneeCard } from '@/components/views/cognee-card'
import { extractError } from '@/lib/extract-error'
import { StatCard } from './knowledge-base/stat-card'
import { CatTab } from './knowledge-base/cat-tab'
import { DocCard } from './knowledge-base/doc-card'
import { UploadDialog } from './knowledge-base/upload-dialog'
import { DocDetailDialog } from './knowledge-base/doc-detail-dialog'
import { VectorStorePanel } from './knowledge-base/vector-store-panel'

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

  const rebuildEmbeddings = useCallback(async () => {
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
  }, [fetchDocs])

  const rebuildFts = useCallback(async () => {
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
  }, [])

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
