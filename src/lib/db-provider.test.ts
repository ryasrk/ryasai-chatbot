import { describe, expect, test, afterEach } from 'bun:test'
import { getDbProvider } from './db-provider'

const original = process.env.DATABASE_URL

afterEach(() => {
  if (original !== undefined) process.env.DATABASE_URL = original
  else delete process.env.DATABASE_URL
})

describe('getDbProvider', () => {
  test('postgresql:// → postgresql', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    expect(getDbProvider()).toBe('postgresql')
  })

  test('postgres:// → postgresql', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db'
    expect(getDbProvider()).toBe('postgresql')
  })

  test('file:./prisma/dev.db → sqlite', () => {
    process.env.DATABASE_URL = 'file:./prisma/dev.db'
    expect(getDbProvider()).toBe('sqlite')
  })

  test('empty → sqlite', () => {
    delete process.env.DATABASE_URL
    expect(getDbProvider()).toBe('sqlite')
  })

  test('mysql:// → sqlite (not postgresql)', () => {
    process.env.DATABASE_URL = 'mysql://user:pass@localhost:3306/db'
    expect(getDbProvider()).toBe('sqlite')
  })
})
