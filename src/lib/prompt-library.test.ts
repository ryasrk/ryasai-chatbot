import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { SavedPrompt } from '@prisma/client'

function makePrompt(over: Partial<SavedPrompt> = {}): SavedPrompt {
  return {
    id: 'p1',
    userId: 'u1',
    title: 'Summarize',
    content: 'Summarize the following:',
    category: 'general',
    isPublic: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...over,
  } as SavedPrompt
}

const mockCreate = mock<(...args: unknown[]) => Promise<SavedPrompt>>(async () => makePrompt())
const mockFindUnique = mock<(...args: unknown[]) => Promise<SavedPrompt | null>>(async () => makePrompt())
const mockFindMany = mock<(...args: unknown[]) => Promise<SavedPrompt[]>>(async () => [makePrompt()])
const mockUpdate = mock<(...args: unknown[]) => Promise<SavedPrompt>>(async () => makePrompt())
const mockDelete = mock(async () => ({}))

mock.module('@/lib/db', () => ({
  db: {
    savedPrompt: {
      create: mockCreate,
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      update: mockUpdate,
      delete: mockDelete,
    },
  },
}))

import { createPrompt, getPrompt, listPrompts, updatePrompt, deletePrompt } from './prompt-library'

function firstCallArg<T>(m: { mock: { calls: unknown[] } }): T {
  return (m.mock.calls[0] as unknown as [T])[0]
}

beforeEach(() => {
  mockCreate.mockClear()
  mockFindUnique.mockClear()
  mockFindMany.mockClear()
  mockUpdate.mockClear()
  mockDelete.mockClear()
  mockCreate.mockImplementation(async () => makePrompt())
  mockFindUnique.mockImplementation(async () => makePrompt())
  mockFindMany.mockImplementation(async () => [makePrompt(), makePrompt({ id: 'p2', category: 'sql' })])
  mockUpdate.mockImplementation(async () => makePrompt({ title: 'Updated' }))
  mockDelete.mockImplementation(async () => ({}))
})

describe('createPrompt', () => {
  test('creates with defaults for category and isPublic', async () => {
    await createPrompt('u1', { title: 'T', content: 'C' })
    const arg = (mockCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    expect(arg.data.userId).toBe('u1')
    expect(arg.data.category).toBe('general')
    expect(arg.data.isPublic).toBe(false)
  })

  test('passes through explicit category and isPublic', async () => {
    await createPrompt('u1', { title: 'T', content: 'C', category: 'sql', isPublic: true })
    const arg = (mockCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    expect(arg.data.category).toBe('sql')
    expect(arg.data.isPublic).toBe(true)
  })
})

describe('getPrompt', () => {
  test('returns prompt by id', async () => {
    const p = await getPrompt('p1')
    expect(p).not.toBeNull()
    expect(p!.id).toBe('p1')
    const arg = firstCallArg<{ where: Record<string, string> }>(mockFindUnique)
    expect(arg.where.id).toBe('p1')
  })

  test('returns null when not found', async () => {
    mockFindUnique.mockImplementation(async () => null)
    expect(await getPrompt('missing')).toBeNull()
  })
})

describe('listPrompts', () => {
  test('returns all when no filter', async () => {
    const list = await listPrompts({})
    expect(list).toHaveLength(2)
    const arg = firstCallArg<{ where: Record<string, unknown> }>(mockFindMany)
    expect(arg.where).toEqual({})
  })

  test('filters by userId', async () => {
    await listPrompts({ userId: 'u1' })
    const arg = firstCallArg<{ where: Record<string, unknown> }>(mockFindMany)
    expect(arg.where.userId).toBe('u1')
  })

  test('filters by category', async () => {
    await listPrompts({ category: 'sql' })
    const arg = firstCallArg<{ where: Record<string, unknown> }>(mockFindMany)
    expect(arg.where.category).toBe('sql')
  })

  test('filters by isPublic', async () => {
    await listPrompts({ isPublic: true })
    const arg = firstCallArg<{ where: Record<string, unknown> }>(mockFindMany)
    expect(arg.where.isPublic).toBe(true)
  })

  test('combines multiple filters', async () => {
    await listPrompts({ userId: 'u1', category: 'sql', isPublic: true })
    const arg = firstCallArg<{ where: Record<string, unknown> }>(mockFindMany)
    expect(arg.where).toEqual({ userId: 'u1', category: 'sql', isPublic: true })
  })
})

describe('updatePrompt', () => {
  test('only sends provided fields', async () => {
    await updatePrompt('p1', { title: 'New' })
    const arg = firstCallArg<{ where: Record<string, string>; data: Record<string, unknown> }>(mockUpdate)
    expect(arg.where.id).toBe('p1')
    expect(arg.data).toEqual({ title: 'New' })
  })

  test('sends all provided fields', async () => {
    await updatePrompt('p1', { title: 'T', content: 'C', category: 'x', isPublic: true })
    const arg = firstCallArg<{ data: Record<string, unknown> }>(mockUpdate)
    expect(arg.data).toEqual({ title: 'T', content: 'C', category: 'x', isPublic: true })
  })
})

describe('deletePrompt', () => {
  test('deletes by id', async () => {
    await deletePrompt('p1')
    const arg = firstCallArg<{ where: Record<string, string> }>(mockDelete)
    expect(arg.where.id).toBe('p1')
  })
})
