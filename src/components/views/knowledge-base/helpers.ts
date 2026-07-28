import {
  FileText,
  FileSpreadsheet,
  FileCode,
  File as FileIcon,
} from 'lucide-react'

export const ACCEPTED = '.pdf,.docx,.xlsx,.txt,.md'
export const MAX_BYTES = 50 * 1024 * 1024

export function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function fileIconFor(type: string): {
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

export const STATUS_BADGE: Record<
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

export function categoryColor(cat: string): string {
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
