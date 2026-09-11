/**
 * Pure helper that assembles the `[Source guidance]` block prepended to the
 * RAG `context` passed to `generateAnswer`. Kept pure (no DB / no LLM) so it
 * can be unit-tested directly with score-ordered truncation edge cases.
 *
 * Spec: docs/superpowers/specs/2026-08-26-editable-context-prompts-design.md §Injection → RAG.
 *
 * Format (when anything non-empty):
 * ```
 * [Source guidance]
 * <orgPrompt line(s)>            ← only when orgPrompt is non-empty
 * Document "<name>": <prompt>    ← one line per doc with a non-empty prompt
 * ```
 *  - Empty org prompt + no doc prompts → return '' (caller injects nothing).
 *  - Budget cap (default 2000): keep prompts in caller-supplied score order,
 *    truncate each prompt with `…[truncated]`, and — if even truncated prompts
 *    won't fit — drop the rest with a `[N source prompts omitted]` note.
 */

export interface SourceGuidancePrompt {
  name: string
  content: string
}

export interface SourceGuidanceOptions {
  /** Total budget for the block (header + body), in characters. Default 2000. */
  budget?: number
  /** Org-wide RAG context prompt (AppConfig.promptSettings.ragContextPrompt). */
  orgPrompt?: string
}

const DEFAULT_BUDGET = 2000

const TRUNC_SUFFIX = '…[truncated]'

/**
 * Build the `[Source guidance]` block. Pure: no I/O, deterministic given the
 * same inputs. Returns '' when there is nothing to inject (fail-closed —
 * callers must check the empty case and leave `context` untouched).
 */
export function buildSourceGuidance(
  prompts: SourceGuidancePrompt[],
  opts: SourceGuidanceOptions = {},
): string {
  const orgPrompt = (opts.orgPrompt ?? '').trim()
  // Caller is responsible for dedupe + score-ordering; here we just filter
  // empty-content entries (a doc whose contextPrompt is whitespace only is a
  // no-op, never a "[Source guidance]" header with no body).
  const docPrompts = prompts.filter((p) => p.name.trim() && p.content.trim())

  if (!orgPrompt && docPrompts.length === 0) return ''

  const budget = Math.max(0, opts.budget ?? DEFAULT_BUDGET)
  const header = '[Source guidance]'
  // Always account for the header line + newline separator.
  let remaining = budget - header.length - 1
  const lines: string[] = []

  // Org prompt first — it always applies to every RAG answer.
  if (orgPrompt) {
    const orgLine = orgPrompt
    if (orgLine.length <= remaining) {
      lines.push(orgLine)
      remaining -= orgLine.length + 1
    } else if (remaining > TRUNC_SUFFIX.length) {
      lines.push(orgLine.slice(0, remaining - TRUNC_SUFFIX.length) + TRUNC_SUFFIX)
      remaining = 0
    }
    // else: no room even for a truncated org line — fall through and drop docs.
  }

  let omitted = 0
  for (const p of docPrompts) {
    const line = `Document "${p.name}": ${p.content.trim()}`
    if (line.length <= remaining) {
      lines.push(line)
      remaining -= line.length + 1
      continue
    }
    if (remaining > TRUNC_SUFFIX.length) {
      // Truncated-but-kept: this prompt counts as included (truncated), NOT
      // omitted — the omitted note is only for prompts we dropped entirely.
      lines.push(line.slice(0, remaining - TRUNC_SUFFIX.length) + TRUNC_SUFFIX)
      remaining = 0
      continue
    }
    // No room left — count as omitted; keep iterating to tally the rest.
    omitted += 1
  }

  if (lines.length === 0) {
    // Even the header alone would be misleading; fail-closed.
    return ''
  }

  const body = lines.join('\n')
  const omittedNote = omitted > 0 ? `\n[${omitted} source prompt${omitted === 1 ? '' : 's'} omitted]` : ''
  // ponytail: the omitted-count note is part of the block, so it must fit
  // inside the budget. If it doesn't, shrink the last kept line (preserving its
  // truncation suffix when present) rather than dropping the note — the note
  // tells the model how many prompts were left out, which is load-bearing for
  // "don't guess beyond the evidence" reasoning.
  const headerLine = `${header}\n`
  const noteBudget = headerLine.length + body.length + omittedNote.length
  if (noteBudget <= budget) {
    return `${headerLine}${body}${omittedNote}`
  }
  // Shrink body to make room for the note (and the header).
  const maxBody = Math.max(0, budget - headerLine.length - omittedNote.length)
  let trimmedBody = body.slice(0, maxBody)
  // Avoid leaving a dangling partial-truncation marker.
  if (trimmedBody.endsWith(TRUNC_SUFFIX) === false && body.length > maxBody) {
    // If we cut mid-line, mark it so the LLM knows content was dropped.
    const space = maxBody - TRUNC_SUFFIX.length
    trimmedBody = space > 0 ? `${body.slice(0, space)}${TRUNC_SUFFIX}` : body.slice(0, maxBody)
  }
  return `${headerLine}${trimmedBody}${omittedNote}`
}
