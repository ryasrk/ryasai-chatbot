import { describe, expect, test } from 'bun:test'
import { DB_PROVIDER_PRESETS } from './db-provider-presets'

describe('db-provider-presets', () => {
  test('has expected number of presets', () => {
    expect(DB_PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(10)
  })

  test('each preset has required fields', () => {
    for (const preset of DB_PROVIDER_PRESETS) {
      expect(preset.id).toBeTruthy()
      expect(preset.label).toBeTruthy()
      expect(preset.family).toBeTruthy()
      expect(typeof preset.defaultPort).toBe('number')
      expect(preset.connectionFormat).toBeTruthy()
    }
  })

  test('contains PostgreSQL preset', () => {
    const pg = DB_PROVIDER_PRESETS.find((p) => p.id === 'POSTGRESQL')
    expect(pg).toBeDefined()
    expect(pg!.defaultPort).toBe(5432)
  })

  test('contains MySQL preset', () => {
    const mysql = DB_PROVIDER_PRESETS.find((p) => p.id === 'MYSQL')
    expect(mysql).toBeDefined()
    expect(mysql!.defaultPort).toBe(3306)
  })

  test('contains MSSQL preset', () => {
    const mssql = DB_PROVIDER_PRESETS.find((p) => p.id === 'MSSQL')
    expect(mssql).toBeDefined()
    expect(mssql!.defaultPort).toBe(1433)
  })

  test('SQLite presets have port 0', () => {
    const sqlite = DB_PROVIDER_PRESETS.filter((p) => p.family.startsWith('SQLITE_'))
    expect(sqlite.length).toBeGreaterThanOrEqual(3)
    for (const s of sqlite) {
      expect(s.defaultPort).toBe(0)
    }
  })

  test('all IDs are unique', () => {
    const ids = DB_PROVIDER_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
