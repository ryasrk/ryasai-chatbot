import { db } from '@/lib/db'

export interface ExportedSession {
  session: { id: string; title: string; createdAt: string }
  messages: Array<{
    role: string
    content: string
    timestamp: string
    toolRuns: Array<{ type: string; status: string; latencyMs: number | null }>
    citations: unknown[]
  }>
}

export async function exportSession(
  sessionId: string,
  format: 'json' | 'markdown',
): Promise<string> {
  const session = await db.chatSession.findUnique({
    where: { id: sessionId },
    select: { id: true, title: true, createdAt: true },
  })
  if (!session) throw new Error(`Session not found: ${sessionId}`)

  const messages = await db.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      sender: true,
      text: true,
      createdAt: true,
      citations: true,
      toolRuns: {
        select: { type: true, status: true, latencyMs: true, inputSummary: true, outputSummary: true },
      },
    },
  })

  const payload: ExportedSession = {
    session: { id: session.id, title: session.title, createdAt: session.createdAt.toISOString() },
    messages: messages.map((m) => ({
      role: m.sender,
      content: m.text,
      timestamp: m.createdAt.toISOString(),
      toolRuns: m.toolRuns.map((t) => ({ type: t.type, status: t.status, latencyMs: t.latencyMs })),
      citations: parseCitations(m.citations),
    })),
  }

  if (format === 'json') return JSON.stringify(payload, null, 2)
  return toMarkdown(payload)
}

function parseCitations(raw: string | null): unknown[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function toMarkdown(data: ExportedSession): string {
  const lines: string[] = []
  lines.push(`# ${data.session.title}`)
  lines.push('')
  lines.push(`_Session ID: ${data.session.id}_`)
  lines.push(`_Exported: ${new Date().toISOString()}_`)
  lines.push('')

  for (const m of data.messages) {
    const label = m.role === 'user' ? 'User' : m.role === 'ai' ? 'Assistant' : 'System'
    lines.push(`## ${label}`)
    lines.push(`_${m.timestamp}_`)
    lines.push('')

    const content = wrapSqlBlocks(m.content)
    lines.push(content)
    lines.push('')

    if (m.toolRuns.length > 0) {
      lines.push('**Tool runs:**')
      for (const t of m.toolRuns) {
        const ms = t.latencyMs != null ? ` (${t.latencyMs}ms)` : ''
        lines.push(`- \`${t.type}\` — ${t.status}${ms}`)
      }
      lines.push('')
    }

    if (m.citations.length > 0) {
      lines.push('**Citations:**')
      for (let i = 0; i < m.citations.length; i++) {
        const c = m.citations[i] as Record<string, unknown>
        const name = typeof c?.name === 'string' ? c.name : typeof c?.documentName === 'string' ? c.documentName : `Citation ${i + 1}`
        lines.push(`[^${i + 1}]: ${name}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function wrapSqlBlocks(text: string): string {
  // ponytail: simple ```sql wrapping for SQL statements — matches keyword-to-semicolon, no full parser.
  return text.replace(/((?:select|with|insert|update|delete)\b[^;]*;?)/gi, '```sql\n$1\n```')
}
