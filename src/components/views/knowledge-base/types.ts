import type { DocumentItem } from '@/lib/types'

export interface ChunkPreview {
  id: string
  chunkIndex: number
  content: string
  tokenCount: number
  keywords: string | null
}

export interface DocDetail extends DocumentItem {
  contentText?: string
  chunkPreview: ChunkPreview[]
  // ponytail: per-document context prompt injected into RAG answer synthesis
  // when this document contributes chunks. Optional because older GET responses
  // predate the column being selected — default to '' when absent.
  contextPrompt?: string
  /** Roles allowed to retrieve this document (admin always included). Absent on responses older than the column. */
  allowedRoles?: string[]
}
