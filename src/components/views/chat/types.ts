import {
  Database,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  Plug,
} from 'lucide-react'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const SUGGESTED_PROMPTS = [
  'What is the total stock of product SKU-902 in the main warehouse?',
  'Show 5 customers with the highest total spending',
  'What are the payment terms for Enterprise customers?',
  'List invoices with overdue status',
] as const

export const CHART_COLORS = ['#2563EB', '#7C3AED', '#16A34A', '#D97706', '#DC2626']

/* ------------------------------------------------------------------ */
/* Tool execution metadata                                            */
/* ------------------------------------------------------------------ */

export type StepStatus = 'pending' | 'running' | 'done' | 'error'

export interface PipelineState {
  thinking: StepStatus
  toolType: string
  tool: StepStatus
  answer: StepStatus
}

export const INITIAL_PIPELINE: PipelineState = {
  thinking: 'pending',
  toolType: '',
  tool: 'pending',
  answer: 'pending',
}

// Status banner metadata per tool type (English labels, per spec).
export const TOOL_META: Record<
  string,
  { label: string; icon: typeof Loader2; tone: string }
> = {
  SQL: {
    label: 'Running SQL query...',
    icon: Database,
    tone: 'text-info',
  },
  RAG: {
    label: 'Searching knowledge base documents...',
    icon: FileText,
    tone: 'text-primary',
  },
  REST_API: {
    label: 'Calling external API...',
    icon: Globe,
    tone: 'text-success',
  },
  PLUGIN: {
    label: 'Querying external tool...',
    icon: Plug,
    tone: 'text-warning',
  },
  CHAT: {
    label: 'Composing answer...',
    icon: MessageSquare,
    tone: 'text-muted-foreground',
  },
}

// Pipeline step icon + short label per tool type.
export const TOOL_ICON: Record<string, typeof Loader2> = {
  SQL: Database,
  RAG: FileText,
  REST_API: Globe,
  PLUGIN: Plug,
  CHAT: MessageSquare,
}

export const TOOL_SHORT: Record<string, string> = {
  SQL: 'Query SQL',
  RAG: 'Knowledge Base',
  REST_API: 'REST API',
  PLUGIN: 'Plugin',
  CHAT: 'Chat',
}

// Data source badge shown above finalized AI messages.
export const TOOL_BADGE: Record<
  string,
  { label: string; icon: typeof Loader2; className: string }
> = {
  SQL: {
    label: 'Database',
    icon: Database,
    className: 'border-info/30 bg-info/15 text-info',
  },
  RAG: {
    label: 'Knowledge Base',
    icon: FileText,
    className: 'border-primary/30 bg-primary/15 text-primary',
  },
  REST_API: {
    label: 'REST API',
    icon: Globe,
    className: 'border-success/30 bg-success/15 text-success',
  },
  PLUGIN: {
    label: 'Plugin',
    icon: Plug,
    className: 'border-warning/30 bg-warning/15 text-warning',
  },
}

export const STEP_TONE: Record<StepStatus, string> = {
  pending: 'bg-muted/40 text-muted-foreground/50 border border-border/50',
  running: 'bg-primary/20 text-primary border border-primary/40 animate-pulse',
  done: 'bg-success/15 text-success border border-success/30',
  error: 'bg-destructive/15 text-destructive border border-destructive/30',
}
