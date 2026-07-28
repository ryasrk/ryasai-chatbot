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
}
