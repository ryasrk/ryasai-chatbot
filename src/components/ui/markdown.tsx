'use client'

import { useState, type ComponentType, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface ChatMarkdownProps {
  content: string
  className?: string
  variant?: 'chat' | 'agentic'
}

function CodeBlock({ children, language }: { children: string; language?: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children)
      setCopied(true)
      toast.success('Code copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }
  return (
    <div className="relative group my-2">
      <div className="flex items-center justify-between bg-muted/60 border border-border/70 rounded-t-md px-2.5 py-1">
        <span className="text-[10px] font-mono text-muted-foreground uppercase">
          {language ?? 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
        </button>
      </div>
      <pre className="bg-muted/40 border border-t-0 border-border/70 rounded-b-md p-2.5 overflow-x-auto text-xs">
        <code className="font-mono">{children}</code>
      </pre>
    </div>
  )
}

const components: Record<string, ComponentType<{ children?: React.ReactNode; className?: string; href?: string; checked?: boolean; node?: unknown }>> = {
  h1: ({ children }) => <h3 className="text-base font-semibold mt-3 mb-1.5">{children}</h3>,
  h2: ({ children }) => <h4 className="text-sm font-semibold mt-3 mb-1.5">{children}</h4>,
  h3: ({ children }) => <h5 className="text-sm font-semibold mt-2 mb-1">{children}</h5>,
  h4: ({ children }) => <h6 className="text-xs font-semibold mt-2 mb-1">{children}</h6>,
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="border-border/60 my-3" />,
  code: ({ children, className }) => {
    const isBlock = (className ?? '').includes('language-')
    if (isBlock) {
      const language = (className ?? '').replace('language-', '').split(' ')[0]
      const text = extractText(children)
      return <CodeBlock language={language}>{text}</CodeBlock>
    }
    return (
      <code className="bg-muted/60 px-1 py-0.5 rounded text-xs font-mono break-words whitespace-normal">
        {children}
      </code>
    )
  },
  pre: ({ children }) => <>{children}</>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/40">{children}</thead>,
  th: ({ children }) => (
    <th className="border px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-primary/40 pl-3 italic text-muted-foreground my-2">
      {children}
    </blockquote>
  ),
  del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,
  input: ({ checked, ...props }) => (
    <input
      type="checkbox"
      checked={checked}
      readOnly
      className="mr-1.5 align-middle h-3 w-3 rounded-none"
      {...props}
    />
  ),
}

function extractText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(extractText).join('')
  if (children && typeof children === 'object' && 'props' in children) {
    return extractText((children as { props: { children?: React.ReactNode } }).props.children)
  }
  return ''
}

export const ChatMarkdown = memo(function ChatMarkdown({ content, className, variant = 'chat' }: ChatMarkdownProps) {
  return (
    <div
      className={cn(
        'min-w-0 break-words [overflow-wrap:anywhere]',
        variant === 'chat' ? 'text-sm leading-relaxed' : 'text-xs leading-relaxed',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
