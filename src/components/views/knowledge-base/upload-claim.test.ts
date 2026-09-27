/**
 * The upload dialog must not claim processing that has only been QUEUED.
 *
 * `POST /api/documents` creates the row with `status: 'ready'` at UPLOAD and then enqueues the embed and
 * cognify jobs — its own audit detail says `jobsQueued: true`. `status: 'ready'` is written BEFORE either
 * job runs, so nothing in the 201 response means the text is searchable yet.
 *
 * The success toast said "Document uploaded & processed." MEASURED consequence: the user is told their
 * document is processed, goes to chat, and the document is not answerable because the embedding is still
 * in flight — the same unearned-claim shape as the original "kenapa processing sangat lamaaa" report,
 * pointed at the other end of the pipeline.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'upload-dialog.tsx'), 'utf-8')

/** Comments stripped: the fix's own note quotes the old wording verbatim. */
const code = src
  .split('\n')
  .map((l) => {
    const t = l.trimStart()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
    const i = l.indexOf('//')
    return i === -1 ? l : l.slice(0, i)
  })
  .join('\n')

describe('upload dialog — the success message matches what actually happened', () => {
  test('the word "processed" is NOT claimed on upload', () => {
    // `toast.error('Document uploaded & processed.')` was the defect. Any surviving claim that the
    // document is processed would re-introduce it; the negative covers the whole file, not one line.
    expect(code).not.toMatch(/uploaded & processed/i)
    expect(code).not.toMatch(/toast\.success\([^)]*processed/i)
  })

  test('the success path says the work is QUEUED', () => {
    const success = code.slice(code.indexOf("if (res.ok && json.document)"))
    const block = success.slice(0, success.indexOf('} else if (res.status === 413)'))
    expect(block).toMatch(/queued/i)
    expect(block).toMatch(/toast\.success\(/)
  })

  test('it still reports the chunk count when the server supplies one', () => {
    // The count IS known at this point, so the honest message is specific rather than vague.
    expect(code).toMatch(/json\.document\.chunkCount/)
  })
})
