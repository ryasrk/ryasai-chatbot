'use client'

/**
 * KnowledgeBaseView — RAG document management UI (spec §3.3).
 *
 * Lists uploaded documents with chunk counts + status, lets admins upload
 * new files (multipart/form-data), preview chunks, delete, and test the RAG
 * retrieval pipeline via /api/documents/search.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import {
  UploadCloud,
  RefreshCw,
  FileText,
  FileSpreadsheet,
  FileCode,
  File as FileIcon,
  Trash2,
  Eye,
  Search,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Layers,
  FileStack,
  X,
  AlertTriangle,
  Pencil,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { DocumentItem } from '@/lib/types'
import {
  normalizeRagSearchResponse,
  type RagSearchMeta,
  type RagSearchResult,
} from '@/lib/rag-search-tester'

/* ------------------------------------------------------------------ helpers */

const CATEGORIES = ['SOP', 'KEBIJAKAN', 'FINANSIAL', 'INVOICE', 'LAINNYA'] as const
type Category = (typeof CATEGORIES)[number]

const ACCEPTED = '.pdf,.docx,.xlsx,.txt,.md'
const MAX_BYTES = 50 * 1024 * 1024

function timeAgo(iso: string | null): string {
  if (!iso) return '-'
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: idLocale })
  } catch {
    return '-'
  }
}

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
      className: 'bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-300',
    }
  if (t === 'docx' || t === 'doc')
    return {
      Icon: FileText,
      className: 'bg-sky-100 text-sky-600 dark:bg-sky-900/40 dark:text-sky-300',
    }
  if (t === 'xlsx' || t === 'xls')
    return {
      Icon: FileSpreadsheet,
      className:
        'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300',
    }
  if (t === 'md')
    return {
      Icon: FileCode,
      className:
        'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300',
    }
  return {
    Icon: FileIcon,
    className:
      'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300',
  }
}

const STATUS_BADGE: Record<
  string,
  { label: string; className: string }
> = {
  ready: {
    label: 'Ready',
    className:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  },
  processing: {
    label: 'Processing',
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  },
  error: {
    label: 'Error',
    className:
      'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  },
}

const CATEGORY_BADGE: Record<string, string> = {
  SOP: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 border-violet-200 dark:border-violet-800',
  KEBIJAKAN:
    'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800',
  FINANSIAL:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  INVOICE:
    'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300 border-teal-200 dark:border-teal-800',
  LAINNYA:
    'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300 border-slate-200 dark:border-slate-700',
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

interface SmartMappingItem {
  id: string
  sourceName: string
  entityType: string
  routingHint: string
  status: string
  synonyms: string[]
  fields: Array<{ source: string; canonical: string }>
}

/* ============================================================ main view */

export function KnowledgeBaseView() {
  const [docs, setDocs] = useState<DocumentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [activeCat, setActiveCat] = useState<Category | 'ALL'>('ALL')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [detailTarget, setDetailTarget] = useState<DocumentItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DocumentItem | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [rebuildingEmbeddings, setRebuildingEmbeddings] = useState(false)
  const [rebuildingFts, setRebuildingFts] = useState(false)
  // Request-id guard: only the latest category fetch may write docs, so rapid
  // tab switches can't let a slow earlier response overwrite the wrong tab.
  const fetchIdRef = useRef(0)

  const fetchDocs = useCallback(async (cat: Category | 'ALL' = 'ALL') => {
    const reqId = ++fetchIdRef.current
    setLoading(true)
    try {
      const url =
        cat === 'ALL' ? '/api/documents' : `/api/documents?category=${cat}`
      const res = await fetch(url, { cache: 'no-store' })
      const json = await res.json()
      if (reqId !== fetchIdRef.current) return // superseded by a newer request
      if (res.ok && Array.isArray(json.documents)) {
        setDocs(json.documents as DocumentItem[])
      } else {
        toast.error(json.error ?? 'Gagal memuat daftar dokumen.')
      }
    } catch (e) {
      toast.error('Kesalahan jaringan saat memuat dokumen.')
      console.error(e)
    } finally {
      if (reqId === fetchIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDocs(activeCat)
  }, [activeCat, fetchDocs])

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if ((res.ok && json.ok) || res.status === 404) {
        toast.success(
          res.status === 404
            ? 'Dokumen sudah tidak ada. Daftar dimuat ulang.'
            : `Dokumen dihapus. ${json.chunkCountRemoved ?? 0} chunk ikut dihapus.`,
        )
        if (detailTarget?.id === id) setDetailTarget(null)
        await fetchDocs(activeCat)
      } else {
        toast.error(json.error ?? 'Gagal menghapus dokumen.')
      }
    } catch (e) {
      toast.error('Kesalahan jaringan saat menghapus.')
      console.error(e)
    } finally {
      setDeleteTarget(null)
      setDeletingId(null)
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
        throw new Error(json.error ?? 'Gagal rebuild embeddings.')
      }
      toast.success('Embeddings selesai diproses.', {
        description: `${json.data.embedded ?? 0} chunk embedded, ${json.data.skipped ?? 0} dilewati.`,
      })
      await fetchDocs(activeCat)
    } catch (e) {
      toast.error('Gagal rebuild embeddings', {
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
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Gagal rebuild FTS.')
      toast.success('Index BM25 selesai diproses.', {
        description: `${json.data.indexed ?? 0} chunk masuk index lexical.`,
      })
    } catch (e) {
      toast.error('Gagal rebuild FTS', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setRebuildingFts(false)
    }
  }

  // Stats
  const totalChunks = docs.reduce((s, d) => s + (d.chunkCount ?? 0), 0)
  const readyCount = docs.filter((d) => d.status === 'ready').length
  const errorCount = docs.filter((d) => d.status !== 'ready').length

  const catCounts: Record<string, number> = {}
  for (const c of CATEGORIES) catCounts[c] = 0
  for (const d of docs) {
    const c = (d.category ?? 'LAINNYA') as Category
    if (catCounts[c] !== undefined) catCounts[c]++
  }

  return (
    <div className="space-y-5">
      {/* Action row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchDocs(activeCat)}
            disabled={loading}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Muat ulang
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={rebuildEmbeddings}
            disabled={rebuildingEmbeddings || docs.length === 0}
          >
            <RefreshCw
              className={cn('h-4 w-4', rebuildingEmbeddings && 'animate-spin')}
            />
            Rebuild Embeddings
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={rebuildFts}
            disabled={rebuildingFts || docs.length === 0}
          >
            <RefreshCw
              className={cn('h-4 w-4', rebuildingFts && 'animate-spin')}
            />
            Rebuild BM25
          </Button>
        </div>
        <Button onClick={() => setUploadOpen(true)} size="sm">
          <UploadCloud className="h-4 w-4" />
          Unggah Dokumen
        </Button>
      </div>

      {/* Stats row — 4 cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Dokumen" value={docs.length} icon={FileStack} tone="slate" />
        <StatCard label="Total Chunk" value={totalChunks} icon={Layers} tone="violet" />
        <StatCard label="Ready" value={readyCount} icon={CheckCircle2} tone="emerald" />
        <StatCard label="Error / Processing" value={errorCount} icon={AlertCircle} tone="rose" />
      </div>

      {/* Category filter tabs */}
      <div className="flex flex-wrap items-center gap-1.5">
        <CatTab
          active={activeCat === 'ALL'}
          onClick={() => setActiveCat('ALL')}
          label="Semua"
          count={docs.length}
        />
        {CATEGORIES.map((c) => (
          <CatTab
            key={c}
            active={activeCat === c}
            onClick={() => setActiveCat(c)}
            label={c}
            count={catCounts[c]}
          />
        ))}
      </div>

      {/* Document list */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Memuat dokumen…
        </div>
      ) : docs.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <FileText className="h-10 w-10 mx-auto text-muted-foreground/60 mb-3" />
            <p className="text-sm text-muted-foreground">
              {activeCat === 'ALL'
                ? 'Belum ada dokumen. Klik Unggah Dokumen untuk menambahkan file ke knowledge base.'
                : `Tidak ada dokumen dengan kategori ${activeCat}.`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {docs.map((d) => (
            <DocCard
              key={d.id}
              doc={d}
              deleting={deletingId === d.id}
              onDetail={() => setDetailTarget(d)}
              onDelete={() => setDeleteTarget(d)}
            />
          ))}
        </div>
      )}

      {/* RAG Search Tester (bonus) */}
      <RagSearchTester />

      <RagEvalPanel />

      <VectorStorePanel />

      <SmartMappingPanel />

      {/* Upload dialog */}
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={() => {
          setUploadOpen(false)
          fetchDocs(activeCat)
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
            <AlertDialogTitle>Hapus dokumen ini?</AlertDialogTitle>
            <AlertDialogDescription>
              Dokumen <strong>{deleteTarget?.name}</strong> beserta{' '}
              {deleteTarget?.chunkCount ?? 0} chunk-nya akan dihapus permanen.
              Tindakan ini dicatat di audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && handleDelete(deleteTarget.id)}
              disabled={!!deletingId}
              className="bg-rose-600 hover:bg-rose-700 text-white"
            >
              {deletingId ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Menghapus...
                </>
              ) : (
                'Hapus'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SmartMappingPanel() {
  const [items, setItems] = useState<SmartMappingItem[]>([])
  const [summary, setSummary] = useState('')
  const [running, setRunning] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState({
    sourceName: '',
    entityType: '',
    routingHint: 'CHAT',
    synonyms: '',
    fieldsText: '',
  })

  const fetchItems = useCallback(() => {
    fetch('/api/smart-mappings', { cache: 'no-store' })
      .then((res) => res.json())
      .then((json) => setItems(json.items ?? []))
      .catch(() => null)
  }, [])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  const generate = async () => {
    setRunning(true)
    try {
      const res = await fetch('/api/smart-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: 'MANUAL',
          sourceName: 'Manual mapping',
          summary,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Gagal membuat mapping.')
      toast.success('Smart mapping dibuat.')
      setSummary('')
      fetchItems()
    } catch (e) {
      toast.error('Gagal membuat smart mapping', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setRunning(false)
    }
  }

  const startEdit = (item: SmartMappingItem) => {
    setEditingId(item.id)
    setDraft({
      sourceName: item.sourceName,
      entityType: item.entityType,
      routingHint: item.routingHint,
      synonyms: item.synonyms?.join(', ') ?? '',
      fieldsText: item.fields?.map((field) => `${field.source}=${field.canonical}`).join('\n') ?? '',
    })
  }

  const patchItem = async (id: string, body: Record<string, unknown>, success: string) => {
    setBusyId(id)
    try {
      const res = await fetch(`/api/smart-mappings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Gagal memperbarui mapping.')
      toast.success(success)
      setEditingId(null)
      fetchItems()
    } catch (e) {
      toast.error('Gagal memperbarui smart mapping', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setBusyId(null)
    }
  }

  const deleteItem = async (id: string) => {
    setBusyId(id)
    try {
      const res = await fetch(`/api/smart-mappings/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Gagal menghapus mapping.')
      toast.success('Smart mapping dihapus.')
      fetchItems()
    } catch (e) {
      toast.error('Gagal menghapus smart mapping', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Smart Mapping AI</CardTitle>
        <p className="text-xs text-muted-foreground">
          Mapping sinonim/entity membantu router memilih SQL, Knowledge, REST, atau Chat.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={2}
            placeholder="contoh: demo_inventory(sku, warehouse, quantity), invoice amount, SLA ticket"
            className="resize-none"
          />
          <Button onClick={generate} disabled={running || !summary.trim()} className="sm:self-end">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Generate
          </Button>
        </div>
        {items.length > 0 && (
          <div className="grid gap-2 md:grid-cols-2">
            {items.slice(0, 6).map((item) => (
              <div key={item.id} className="rounded-md border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{item.routingHint}</Badge>
                  <Badge variant={item.status === 'active' ? 'default' : 'outline'}>
                    {item.status}
                  </Badge>
                  <span className="text-sm font-medium">{item.entityType}</span>
                  <span className="text-xs text-muted-foreground">{item.sourceName}</span>
                </div>
                {item.synonyms?.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.synonyms.slice(0, 8).join(', ')}
                  </p>
                )}
                {editingId === item.id ? (
                  <div className="mt-3 grid gap-2">
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Input
                        value={draft.sourceName}
                        onChange={(e) => setDraft((prev) => ({ ...prev, sourceName: e.target.value }))}
                        placeholder="Source"
                      />
                      <Input
                        value={draft.entityType}
                        onChange={(e) => setDraft((prev) => ({ ...prev, entityType: e.target.value }))}
                        placeholder="Entity"
                      />
                      <Select
                        value={draft.routingHint}
                        onValueChange={(value) => setDraft((prev) => ({ ...prev, routingHint: value }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="SQL">SQL</SelectItem>
                          <SelectItem value="RAG">Knowledge</SelectItem>
                          <SelectItem value="REST">REST</SelectItem>
                          <SelectItem value="CHAT">Chat</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Textarea
                      value={draft.synonyms}
                      onChange={(e) => setDraft((prev) => ({ ...prev, synonyms: e.target.value }))}
                      rows={2}
                      placeholder="Sinonim, pisahkan koma"
                    />
                    <Textarea
                      value={draft.fieldsText}
                      onChange={(e) => setDraft((prev) => ({ ...prev, fieldsText: e.target.value }))}
                      rows={3}
                      placeholder="source=canonical per baris"
                    />
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                        <X className="h-4 w-4" />
                        Batal
                      </Button>
                      <Button
                        size="sm"
                        disabled={busyId === item.id}
                        onClick={() =>
                          patchItem(item.id, {
                            ...draft,
                            status: item.status === 'draft' ? 'active' : item.status,
                          }, 'Smart mapping diperbarui.')
                        }
                      >
                        {busyId === item.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                        Simpan
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => startEdit(item)}>
                      <Pencil className="h-4 w-4" />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === item.id}
                      onClick={() =>
                        patchItem(
                          item.id,
                          { status: item.status === 'active' ? 'disabled' : 'active' },
                          item.status === 'active' ? 'Smart mapping dinonaktifkan.' : 'Smart mapping aktif.',
                        )
                      }
                    >
                      {busyId === item.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                      {item.status === 'active' ? 'Disable' : 'Approve'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === item.id}
                      className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                      onClick={() => deleteItem(item.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Hapus
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RagEvalPanel() {
  const [casesText, setCasesText] = useState(
    JSON.stringify(
      [
        {
          question: 'Apa isi utama dokumen?',
          expectedSource: '',
          expectedText: '',
        },
      ],
      null,
      2,
    ),
  )
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{
    summary?: {
      total: number
      precisionAtK: number
      groundedRate: number
      avgLatencyMs: number
    }
    results?: Array<{
      question: string
      ok: boolean
      grounded: boolean
      latencyMs: number
      topSource?: string
      returned: number
    }>
  } | null>(null)

  const runEval = async () => {
    setRunning(true)
    try {
      const parsed = JSON.parse(casesText)
      const res = await fetch('/api/rag/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases: parsed, topK: 4 }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Evaluasi gagal.')
      setResult(json)
      toast.success('Evaluasi RAG selesai.')
    } catch (e) {
      toast.error('Gagal evaluasi RAG', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">RAG Evaluation</CardTitle>
        <p className="text-xs text-muted-foreground">
          Uji precision@K, grounded rate, dan latency retrieval dari golden questions.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Textarea
          value={casesText}
          onChange={(e) => setCasesText(e.target.value)}
          rows={9}
          className="font-mono text-xs"
        />
        <div className="space-y-3">
          <Button onClick={runEval} disabled={running} className="w-full">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Jalankan Evaluasi
          </Button>
          {result?.summary && (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <Metric label="Cases" value={result.summary.total} />
              <Metric label="Latency" value={`${result.summary.avgLatencyMs}ms`} />
              <Metric label="Precision@K" value={`${Math.round(result.summary.precisionAtK * 100)}%`} />
              <Metric label="Grounded" value={`${Math.round(result.summary.groundedRate * 100)}%`} />
            </div>
          )}
          {result?.results?.slice(0, 5).map((item) => (
            <div key={item.question} className="rounded-md border p-2 text-xs">
              <div className="font-medium line-clamp-1">{item.question}</div>
              <div className="mt-1 text-muted-foreground">
                {item.ok ? 'match' : 'miss'} · {item.grounded ? 'grounded' : 'not grounded'} · {item.returned} chunk
              </div>
              {item.topSource && (
                <div className="mt-1 truncate text-muted-foreground">{item.topSource}</div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-semibold">{value}</div>
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
      .catch(() => null)
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
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
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Gagal menyimpan.')
      setApiKey('')
      toast.success('Konfigurasi vector DB tersimpan.')
    } catch (e) {
      toast.error('Gagal menyimpan vector DB', {
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
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Gagal test vector DB.')
      toast.success('Vector DB siap.', {
        description: json.data?.collectionName ?? json.data?.provider,
      })
    } catch (e) {
      toast.error('Vector DB belum siap', {
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
            <CardTitle className="text-base">Vector DB</CardTitle>
            <p className="text-xs text-muted-foreground">
              Qdrant/Milvus untuk semantic retrieval eksternal. Internal tetap fallback.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Provider</Label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="INTERNAL">Internal</SelectItem>
              <SelectItem value="QDRANT">Qdrant</SelectItem>
              <SelectItem value="MILVUS">Milvus</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Base URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider === 'QDRANT' ? 'http://localhost:6333' : 'http://localhost:19530'}
            className="font-mono text-sm"
            disabled={provider === 'INTERNAL'}
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
            <Label>Dimensi</Label>
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
          <Label>API Key</Label>
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="optional"
            className="font-mono text-sm"
            autoComplete="new-password"
          />
        </div>
        <div className="flex justify-end gap-2 md:col-span-2">
          <Button variant="outline" onClick={test} disabled={testing || provider === 'INTERNAL'}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Test
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Simpan
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
  tone,
}: {
  label: string
  value: number
  icon: typeof FileStack
  tone: 'slate' | 'violet' | 'emerald' | 'rose'
}) {
  const toneCls = {
    slate: 'text-slate-600 bg-slate-100 dark:bg-slate-800/60 dark:text-slate-300',
    violet:
      'text-violet-600 bg-violet-100 dark:bg-violet-900/40 dark:text-violet-300',
    emerald:
      'text-emerald-600 bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300',
    rose: 'text-rose-600 bg-rose-100 dark:bg-rose-900/40 dark:text-rose-300',
  }[tone]
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={cn('h-10 w-10 rounded-lg flex items-center justify-center', toneCls)}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-semibold leading-tight">{value}</div>
          <div className="text-xs text-muted-foreground truncate">{label}</div>
        </div>
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
          'text-[10px] rounded-full px-1.5 py-0.5',
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
}: {
  doc: DocumentItem
  deleting?: boolean
  onDetail: () => void
  onDelete: () => void
}) {
  const { Icon, className: iconCls } = fileIconFor(doc.type)
  const status = STATUS_BADGE[doc.status] ?? STATUS_BADGE.error
  const catBadge =
    CATEGORY_BADGE[doc.category ?? 'LAINNYA'] ?? CATEGORY_BADGE.LAINNYA

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'h-10 w-10 rounded-lg flex items-center justify-center shrink-0',
              iconCls,
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm leading-snug break-words line-clamp-2">
              {doc.name}
            </CardTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={cn('text-[10px]', catBadge)}>
                {doc.category ?? 'LAINNYA'}
              </Badge>
              <Badge variant="outline" className={cn('text-[10px]', status.className)}>
                {status.label}
              </Badge>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-3">
        {/* meta */}
        <div className="grid grid-cols-2 gap-y-1.5 gap-x-2 text-xs">
          <div className="text-muted-foreground">Ukuran</div>
          <div className="text-right font-medium">{formatSize(doc.sizeBytes)}</div>
          <div className="text-muted-foreground">Chunk</div>
          <div className="text-right font-medium">{doc.chunkCount} chunk</div>
          <div className="text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" /> Diunggah
          </div>
          <div className="text-right text-muted-foreground truncate">
            {timeAgo(doc.createdAt)}
          </div>
        </div>

        {doc.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 italic">
            “{doc.description}”
          </p>
        )}

        <div className="mt-auto grid grid-cols-2 gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={onDetail} className="text-xs">
            <Eye className="h-3.5 w-3.5" />
            Lihat Detail
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {deleting ? 'Menghapus' : 'Hapus'}
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
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onUploaded: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [category, setCategory] = useState<Category>('SOP')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setFile(null)
    setCategory('SOP')
    setDescription('')
    setSizeError(null)
    setDragOver(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const pickFile = (f: File | null | undefined) => {
    if (!f) return
    if (f.size > MAX_BYTES) {
      setSizeError(
        `Ukuran file ${formatSize(f.size)} melebihi batas 50 MB (spec §8).`,
      )
      setFile(null)
      return
    }
    if (f.size <= 0) {
      setSizeError('File kosong.')
      setFile(null)
      return
    }
    setSizeError(null)
    setFile(f)
  }

  const handleSubmit = async () => {
    if (!file) {
      toast.error('Pilih file terlebih dahulu.')
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
      fd.append('category', category)
      fd.append('description', description)
      const res = await fetch('/api/documents', { method: 'POST', body: fd })
      const json = await res.json()
      if (res.ok && json.document) {
        toast.success('Dokumen berhasil diunggah & diproses.')
        reset()
        onUploaded()
      } else if (res.status === 413) {
        setSizeError(
          `File melebihi 50 MB (spec §8). Ukuran: ${formatSize(
            json.sizeBytes ?? file.size,
          )}.`,
        )
      } else {
        toast.error(json.error ?? 'Gagal mengunggah dokumen.')
      }
    } catch (e) {
      toast.error('Kesalahan jaringan saat mengunggah.')
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
          <DialogTitle>Unggah Dokumen</DialogTitle>
          <DialogDescription>
            Mendukung PDF, DOCX, XLSX, TXT, MD. Maks 50 MB. File akan di-chunk
            otomatis untuk retrieval RAG.
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
                  aria-label="Hapus pilihan file"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <>
                <UploadCloud className="h-8 w-8 mx-auto text-muted-foreground/60 mb-2" />
                <p className="text-sm font-medium">
                  Tarik file ke sini atau klik untuk memilih
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  PDF, DOCX, XLSX, TXT, MD · maks 50 MB
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
            <Label htmlFor="doc-cat">Kategori</Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as Category)}
            >
              <SelectTrigger id="doc-cat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="doc-desc">Deskripsi (opsional)</Label>
            <Textarea
              id="doc-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Ringkasan singkat isi dokumen…"
              className="resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Batal
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !file}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Memproses &amp; chunking…
              </>
            ) : (
              <>
                <UploadCloud className="h-4 w-4" />
                Unggah
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
            Detail dokumen + preview chunk. Muat lebih banyak chunk via
            paginasi.
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
          setError(j.error ?? 'Gagal memuat detail dokumen.')
        }
      })
      .catch(() => {
        if (!cancelled) setError('Kesalahan jaringan.')
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
        toast.error(j.error ?? 'Gagal memuat chunk.')
      }
    } catch {
      toast.error('Kesalahan jaringan saat memuat chunk.')
    } finally {
      setLoadingMore(false)
    }
  }

  if (loadingChunks && !detail) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Memuat detail…
      </div>
    )
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Gagal</AlertTitle>
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
        <Meta label="Kategori" value={detail.category ?? 'LAINNYA'} />
        <Meta label="Tipe" value={detail.type} />
        <Meta label="Ukuran" value={formatSize(detail.sizeBytes)} />
        <Meta label="Status" value={detail.status} />
      </div>

      {detail.description && (
        <p className="text-xs text-muted-foreground italic">
          “{detail.description}”
        </p>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {total} chunk total · menampilkan {allChunks.length}
        </div>
      </div>

      {/* chunk list */}
      <div className="space-y-2">
        {allChunks.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            Tidak ada chunk tersedia.
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
                Memuat…
              </>
            ) : (
              <>
                <Layers className="h-3.5 w-3.5" />
                Muat lebih banyak chunk (hal. {page + 1}/{totalPages})
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
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div className="text-xs font-medium truncate">{value}</div>
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
          <Badge variant="secondary" className="text-[10px]">
            #{chunk.chunkIndex}
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            {chunk.tokenCount} token
          </span>
        </div>
        {chunk.content.length > 280 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[10px] text-primary hover:underline"
          >
            {expanded ? 'Ciutkan' : 'Lihat penuh'}
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
              className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
            >
              {k}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------- rag search tester */

function RagSearchTester() {
  const [query, setQuery] = useState('')
  const [topK, setTopK] = useState('4')
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<RagSearchResult[] | null>(null)
  const [meta, setMeta] = useState<RagSearchMeta | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSearch = async () => {
    const q = query.trim()
    if (!q) {
      toast.error('Masukkan kata kunci pencarian.')
      return
    }
    setRunning(true)
    setResults(null)
    setMeta(null)
    setError(null)
    try {
      const res = await fetch('/api/documents/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, topK: Number(topK) || 4 }),
      })
      const j = await res.json()
      if (res.ok && Array.isArray(j.results)) {
        const normalized = normalizeRagSearchResponse(j)
        setResults(normalized.results)
        setMeta(normalized.meta)
        if (normalized.results.length === 0) {
          toast.info('Tidak ada chunk yang cocok ditemukan.')
        }
      } else {
        setError(j.error ?? 'Gagal melakukan pencarian.')
      }
    } catch (e) {
      console.error(e)
      setError('Kesalahan jaringan saat mencari.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <Search className="h-4.5 w-4.5" />
          </div>
          <div>
            <CardTitle className="text-base">RAG Search Tester</CardTitle>
            <p className="text-xs text-muted-foreground">
              Uji pipeline retrieval: kata kunci → chunk paling relevan (skor
              overlap + keyword tag).
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <Textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={2}
            placeholder="contoh: prosedur pengajuan cuti tahunan"
            className="resize-none flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleSearch()
              }
            }}
          />
          <div className="flex sm:flex-col gap-2 sm:w-32">
            <div className="flex-1">
              <Label htmlFor="topk" className="text-[10px] text-muted-foreground">
                Top K
              </Label>
              <Input
                id="topk"
                type="number"
                min={1}
                max={50}
                value={topK}
                onChange={(e) => setTopK(e.target.value)}
                className="h-9"
              />
            </div>
            <Button
              onClick={handleSearch}
              disabled={running || !query.trim()}
              className="sm:mt-auto"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Cari
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {meta && (
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant="outline" className="text-[10px]">
                {meta.candidatesScanned} chunk dipindai
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                top {meta.topK}
              </Badge>
              {meta.queryTokens.length > 0 && (
                <span className="min-w-0 break-words">
                  Token: {meta.queryTokens.join(', ')}
                </span>
              )}
            </div>
          </div>
        )}

        {results && results.length > 0 && (
          <ScrollArea className="max-h-[420px] pr-2">
            <div className="space-y-2">
              {results.map((r) => (
                <div
                  key={r.chunkId}
                  className="rounded-md border bg-muted/20 p-3"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs font-medium truncate">
                        {r.documentName}
                      </span>
                      <Badge variant="secondary" className="text-[10px]">
                        #{r.chunkIndex}
                      </Badge>
                    </div>
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300"
                    >
                      skor {r.score}
                    </Badge>
                  </div>
                  <p className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80 line-clamp-4">
                    {r.content.slice(0, 280)}
                    {r.content.length > 280 ? '…' : ''}
                  </p>
                  <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                    <span>{r.scoreBreakdown.contentHits} content hit</span>
                    <span>{r.scoreBreakdown.keywordHits} keyword hit</span>
                    <span>{r.scoreBreakdown.phraseHits} phrase hit</span>
                    {r.scoreBreakdown.semanticScore > 0 && (
                      <span>
                        semantic +{r.scoreBreakdown.semanticScore.toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        {results && results.length === 0 && !error && (
          <p className="text-xs text-muted-foreground italic py-4 text-center">
            Tidak ada chunk yang cocok dengan kueri. Coba kata kunci lain.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
