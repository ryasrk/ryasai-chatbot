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
import { CardGridSkeleton, EmptyState, ErrorState } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
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
import { MemoryStatusCard } from '@/components/views/memory-status-card'
import { extractError } from '@/lib/extract-error'
import { StatCard } from './knowledge-base/stat-card'
import { CatTab } from './knowledge-base/cat-tab'
import { DocCard, isCognifySettled } from './knowledge-base/doc-card'
import { UploadDialog } from './knowledge-base/upload-dialog'
import { DocDetailDialog } from './knowledge-base/doc-detail-dialog'
import { VectorStorePanel } from './knowledge-base/vector-store-panel'

/* ============================================================ main view */

export function KnowledgeBaseView() {
  const [docs, setDocs] = useState<DocumentItem[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [loadError, setLoadError] = useState(false)
  const [activeCat, setActiveCat] = useState<string>('ALL')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [detailTarget, setDetailTarget] = useState<DocumentItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DocumentItem | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [, setRebuildingEmbeddings] = useState(false)
  const [, setRebuildingFts] = useState(false)
  // Controlled so another view can open a specific tab directly — the dashboard's AI Memory card
  // sends people here, and an uncontrolled `defaultValue` would ignore that target.
  const [tab, setTab] = useState('documents')

  useEffect(() => {
    const applyTab = (raw: string | null | undefined) => {
      if (raw === 'documents' || raw === 'vector') setTab(raw)
      /*
       * `cognee` is a RETIRED target — the tab moved to AI Configuration to end the duplicate card.
       *
       * A bookmark, a dashboard link or a doc that still says `?tab=cognee` must not land on a blank
       * panel: the tab no longer exists, so `setTab('cognee')` would select nothing and render an
       * empty card. Forwarding keeps every existing link working and, more importantly, shows the
       * user where the settings went instead of looking broken.
       */
      if (raw === 'cognee') {
        window.dispatchEvent(
          new CustomEvent('navigate-view', { detail: { view: 'ai-config', tab: 'memory' } }),
        )
      }
    }
    applyTab(new URLSearchParams(window.location.search).get('tab'))
    const onNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail as { view?: string; tab?: string } | undefined
      if (detail?.view === 'knowledge') applyTab(detail.tab)
    }
    window.addEventListener('navigate-view', onNavigate as EventListener)
    return () => window.removeEventListener('navigate-view', onNavigate as EventListener)
  }, [])

  /**
   * Load the document list.
   *
   * `quiet` distinguishes a POLL from a user-visible load, and it is not cosmetic.
   *
   * The poll below reused this function as-is, so every 5 seconds it set `loading`, and the render
   * branch for `loading` swaps the card grid for `CardGridSkeleton` (or, before the 200ms delayed
   * skeleton threshold, for nothing at all). Each swap UNMOUNTS every `DocCard` — discarding each
   * card's optimistic override, its `elapsed` counter and its own poll chain — and then mounts a fresh
   * set that has forgotten a reprocess was in flight and shows whatever the last list said. The
   * documents appeared to flicker to skeleton and back, the elapsed counter restarted from 0, and the
   * card-level poll could never outlive one 5-second tick. A status screen that blanks itself while it
   * is working is its own kind of dishonest.
   *
   * So a poll refreshes the DATA without announcing a load: `loading` and `loadError` are the
   * user-facing states of an initial load / explicit retry, and a failed background poll must not
   * replace a perfectly good list with a full-page error either.
   */
  const fetchDocs = useCallback(async (opts?: { quiet?: boolean }) => {
    const quiet = opts?.quiet === true
    if (!quiet) {
      setLoading(true)
      setLoadError(false)
    }
    try {
      const res = await fetch('/api/documents', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok && Array.isArray(json.documents)) {
        setDocs(json.documents as DocumentItem[])
      } else if (!quiet) {
        setLoadError(true)
        toast.error(extractError(json.error, 'Failed to load document list.'))
      }
    } catch (e) {
      if (!quiet) {
        setLoadError(true)
        toast.error('Network error while loading documents.')
        console.error(e)
      }
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDocs()
  }, [fetchDocs])

  /*
   * POLL THE LIST WHILE ANY DOCUMENT IS STILL SETTLING.
   *
   * The list was fetched ONCE on mount and never again, so a document uploaded in another tab, or one
   * whose cognify step finished while this view was open, kept whatever status the first fetch saw —
   * for the lifetime of the page. Reproduced on a real install: the DB said `ready`/`completed` with 4
   * chunks while the card said "processing" indefinitely.
   *
   * The card polls itself after a reprocess, but that only covers the reprocess case: an upload, a
   * scheduled job, or a second browser window had no path to update this list at all.
   *
   * Bounded twice, deliberately: the interval stops as soon as nothing is pending, and the ceiling
   * stops it claiming to make progress on a document that never settles. A poll that runs forever is a
   * battery drain on a phone and a dead-socket risk behind a flaky connection.
   */
  /*
   * Is ANY document still settling?
   *
   * Deliberately NOT `!isCognifySettled(...)` for a null status. `null` means "this row never had a
   * cognify status at all" — for a document uploaded before memory was switched on, or on an install
   * where it is off, that is permanent, and treating it as pending would poll this list forever. The
   * card's own rule is the opposite for the same input, and both are correct for their question: the
   * card is asking "did the job I just queued report back?" (no → keep looking), while this is asking
   * "is there anything worth watching?" (no → stop).
   */
  const anyPending = docs.some(
    (d) => d.status === 'processing' || (d.cognifyStatus != null && !isCognifySettled(d.cognifyStatus)),
  )

  useEffect(() => {
    if (!anyPending) return
    const POLL_INTERVAL_MS = 5_000
    const POLL_CEILING_MS = 10 * 60_000
    const startedAt = Date.now()
    const t = setInterval(() => {
      if (Date.now() - startedAt > POLL_CEILING_MS) {
        clearInterval(t)
        return
      }
      // Quiet: refresh the data ONLY. See `fetchDocs` — a poll that sets `loading` unmounts and resets
      // every card on every tick.
      void fetchDocs({ quiet: true })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(t)
  }, [anyPending, fetchDocs])

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

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 overflow-x-auto -mx-1 px-1 pb-1">
            <TabsList className="w-max">
              <TabsTrigger value="documents" className="gap-1.5 text-xs">
                <FileText className="h-3.5 w-3.5" />
                Documents
              </TabsTrigger>
              <TabsTrigger value="vector" className="gap-1.5 text-xs">
                <Database className="h-3.5 w-3.5" />
                Vector Store
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <Button size="sm" icon={<UploadCloud className="h-3.5 w-3.5" />} onClick={() => setUploadOpen(true)}>
              Upload
            </Button>
          </div>
        </div>

        {/*
          Status and a link, NOT the full settings card. The complete editor lives only in
          AI Configuration — a second editable copy here is how two menus drift apart, which is
          exactly what happened when this card appeared in both places.
        */}
        <MemoryStatusCard />

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
      {/* ponytail: gate on `loading` — otherwise the first 200 ms falls through
          to the empty state and the view paints empty → skeleton → cards. */}
      {loading ? (
        showSkeleton ? <CardGridSkeleton count={6} /> : null
      ) : loadError ? (
        <ErrorState message="Failed to load documents." onRetry={() => void fetchDocs()} />
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
