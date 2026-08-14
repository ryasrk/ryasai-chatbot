import { describe, expect, test } from 'bun:test'
import { DB_PROVIDER_PRESETS, VECTOR_STORE_PRESETS } from './db-provider-presets'

describe('db-provider-presets', () => {
  test('has expected number of presets', () => {
    expect(DB_PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(8)
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

  test('all providers have a real connector family', () => {
    const realFamilies = ['POSTGRESQL', 'MYSQL', 'MSSQL', 'CLICKHOUSE']
    for (const preset of DB_PROVIDER_PRESETS) {
      expect(realFamilies).toContain(preset.family)
    }
  })

  test('all IDs are unique', () => {
    const ids = DB_PROVIDER_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('vector-store presets', () => {
  // ponytail: the panel's provider switch (and the PUT validation) relies on
  // every EXTERNAL preset shipping a non-empty baseUrlPlaceholder. When it was
  // empty, switching providers silently kept the OLD provider's URL — a Qdrant
  // URL saved against a Milvus config fails only at search time, opaque.
  test('every external backend has a non-empty baseUrlPlaceholder', () => {
    for (const p of VECTOR_STORE_PRESETS) {
      if (p.backend === 'INTERNAL') continue
      expect(p.baseUrlPlaceholder.length).toBeGreaterThan(0)
    }
  })

  test('placeholders are distinct per backend so switching swaps the URL', () => {
    const byBackend = new Map<string, string>()
    for (const p of VECTOR_STORE_PRESETS) {
      if (byBackend.has(p.backend)) {
        // same backend may legitimately differ (Qdrant local vs cloud)
        continue
      }
      byBackend.set(p.backend, p.baseUrlPlaceholder)
    }
    const urls = [...byBackend.values()]
    expect(new Set(urls).size).toBe(urls.length)
  })

  test('INTERNAL has an empty placeholder (URL not applicable)', () => {
    const internal = VECTOR_STORE_PRESETS.find((p) => p.backend === 'INTERNAL')
    expect(internal).toBeDefined()
    expect(internal!.baseUrlPlaceholder).toBe('')
  })

  test('presets requiring an API key are flagged', () => {
    const pinecone = VECTOR_STORE_PRESETS.find((p) => p.backend === 'PINECONE')
    expect(pinecone?.needsApiKey).toBe(true)
    const qdrantCloud = VECTOR_STORE_PRESETS.find((p) => p.id === 'QDRANT_CLOUD')
    expect(qdrantCloud?.needsApiKey).toBe(true)
    const local = VECTOR_STORE_PRESETS.find((p) => p.id === 'QDRANT')
    expect(local?.needsApiKey).toBe(false)
  })
})
