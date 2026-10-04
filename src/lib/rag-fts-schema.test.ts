import { expect, mock, test } from 'bun:test'
let attempts = 0
let release: () => void = () => {}
const waiting = new Promise<void>(resolve => { release = resolve })
mock.module('@/lib/db-provider', () => ({ getDbProvider: () => 'sqlite' }))
mock.module('@/lib/db', () => ({ db: {
  $executeRawUnsafe: async () => {
    attempts++
    if (attempts === 1) throw new Error('schema unavailable')
    await waiting
    return 0
  },
} }))
import { ensureRagFtsTable } from './rag-fts'
test('SQLite initialization is retryable and shared by concurrent callers', async () => {
  await expect(ensureRagFtsTable()).rejects.toThrow('schema unavailable')
  const calls = [ensureRagFtsTable(), ensureRagFtsTable(), ensureRagFtsTable()]
  expect(attempts).toBe(2)
  release()
  await Promise.all(calls)
  await ensureRagFtsTable()
  expect(attempts).toBe(2)
})
