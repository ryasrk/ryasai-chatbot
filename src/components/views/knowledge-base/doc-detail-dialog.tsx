'use client'

import { useEffect, useState, useCallback } from 'react'
import { FileText, Loader2, Layers, AlertCircle, History, RotateCcw, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { DetailSkeleton } from '@/components/ui/view-states'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { extractError } from '@/lib/extract-error'
import type { DocumentItem } from '@/lib/types'
import type { ChunkPreview, DocDetail } from './types'
import { formatSize } from './helpers'

export function DocDetailDialog({
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
  const { id, chunkCount } = doc
  const [detail, setDetail] = useState<DocDetail | null>(null)
  const [extraChunks, setExtraChunks] = useState<ChunkPreview[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(chunkCount)
  const [loadingChunks, setLoadingChunks] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/documents/${id}`, { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json()
        if (cancelled) return
        if (r.ok && j.document) {
          setDetail(j.document as DocDetail)
          setTotal(j.document.chunkCount ?? chunkCount)
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
  }, [id, chunkCount])

  const loadMore = async () => {
    const nextPage = page + 1
    setLoadingMore(true)
    try {
      const res = await fetch(
        `/api/documents/${id}/chunks?page=${nextPage}&pageSize=20`,
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
    return <DetailSkeleton />
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

      <VersionHistory docId={id} />
    </div>
  )
}

function VersionHistory({ docId }: { docId: string }) {
  const [versions, setVersions] = useState<Array<{ id: string; version: number; createdAt: string }>>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/documents/${docId}/versions`, { cache: 'no-store' })
      const j = await res.json()
      if (res.ok && Array.isArray(j.versions)) setVersions(j.versions)
    } catch {
      // silent fail — versions are optional
    } finally {
      setLoading(false)
    }
  }, [docId])

  useEffect(() => { load() }, [load])

  const createSnapshot = async () => {
    setCreating(true)
    try {
      const res = await fetch(`/api/documents/${docId}/versions`, { method: 'POST' })
      if (res.ok) { toast.success('Snapshot created'); load() }
      else { const j = await res.json().catch(() => ({})); toast.error(extractError(j.error, 'Failed to create snapshot.')) }
    } catch { toast.error('Network error.') } finally { setCreating(false) }
  }

  const restore = async (versionId: string) => {
    setRestoringId(versionId)
    try {
      const res = await fetch(`/api/documents/${docId}/versions/${versionId}`, { method: 'POST' })
      if (res.ok) {
        const j = await res.json()
        toast.success(`Restored to version ${j.version ?? 'previous'}`)
      } else {
        const j = await res.json().catch(() => ({}))
        toast.error(extractError(j.error, 'Failed to restore.'))
      }
    } catch { toast.error('Network error.') } finally { setRestoringId(null) }
  }

  return (
    <div className="space-y-2 pt-3 border-t mt-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium flex items-center gap-1.5">
          <History className="h-3.5 w-3.5" />
          Version History
        </div>
        <Button variant="outline" size="sm" onClick={createSnapshot} disabled={creating} className="h-6 text-xs gap-1">
          {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Snapshot
        </Button>
      </div>
      {loading ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-2">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading versions…
        </div>
      ) : versions.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-1">No snapshots yet.</p>
      ) : (
        <div className="space-y-1">
          {versions.map((v) => (
            <div key={v.id} className="flex items-center justify-between rounded-md border bg-background px-2.5 py-1.5">
              <div className="text-xs">
                <span className="font-medium">v{v.version}</span>
                <span className="text-muted-foreground ml-2">
                  {new Date(v.createdAt).toLocaleString()}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => restore(v.id)}
                disabled={restoringId === v.id}
                className="h-6 text-xs gap-1"
              >
                {restoringId === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                Restore
              </Button>
            </div>
          ))}
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
