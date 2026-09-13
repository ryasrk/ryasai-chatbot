import { describe, expect, test } from 'bun:test'
import {
  DB_PROVIDER_PRESETS,
  VECTOR_STORE_PRESETS,
  VALID_DB_PROVIDER_IDS,
  VALID_VECTOR_STORE_PROVIDER_IDS,
  getDbProviderPreset,
  getDbProtocolFamily,
  getVectorStorePreset,
  getVectorStoreBackend,
} from './db-provider-presets'

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

/**
 * getDbProtocolFamily is the function that SELECTS THE DRIVER.
 * `connectors.ts:67` calls it and switches on the result to build a PostgresConnector, MysqlConnector,
 * MssqlConnector or ClickHouseConnector. It had never been executed by any test -- the one test that
 * reached `connectors.ts` mocked it out entirely (`getDbProtocolFamily: () => 'sql'`), and the tests in
 * this file only asserted on the DATA (preset fields), never on the function.
 *
 * A wrong family therefore means a Supabase/Neon/PlanetScale/TiDB/CockroachDB integration is handed the
 * wrong driver -- and the failure surfaces as a confusing connection error, not as a wrong answer here.
 */
describe('getDbProtocolFamily — driver selection', () => {
  test('resolves every preset id to its OWN declared family', () => {
    // Derived from the preset table itself, so adding a provider whose family disagrees with its id
    // (the managed-provider case below) is still checked against what the preset says.
    for (const preset of DB_PROVIDER_PRESETS) {
      expect(getDbProtocolFamily(preset.id)).toBe(preset.family)
    }
  })

  test('MANAGED providers map to the family of the engine they run, not to their own id', () => {
    // This is the property that makes the function necessary at all: SUPABASE is not a literal in the
    // DbProtocolFamily union, so an id-to-family pass-through would return 'SUPABASE' and the switch in
    // connectors.ts would fall through to the default arm. All four managed Postgres/MySQL-compatible
    // providers must resolve to their real engine.
    expect(getDbProtocolFamily('SUPABASE')).toBe('POSTGRESQL')
    expect(getDbProtocolFamily('NEON')).toBe('POSTGRESQL')
    expect(getDbProtocolFamily('COCKROACHDB')).toBe('POSTGRESQL')
    expect(getDbProtocolFamily('PLANETSCALE')).toBe('MYSQL')
    expect(getDbProtocolFamily('TIDB')).toBe('MYSQL')
  })

  test('the legacy family names pass straight through (no preset row)', () => {
    // These three ARE literals in the union and have no preset entry, so they take the fallback line
    // rather than the preset lookup. Kept so an existing integration whose provider string is a raw
    // family name keeps working.
    expect(getDbProtocolFamily('POSTGRESQL')).toBe('POSTGRESQL')
    expect(getDbProtocolFamily('MYSQL')).toBe('MYSQL')
    expect(getDbProtocolFamily('MSSQL')).toBe('MSSQL')
  })

  test('an unknown provider falls back to POSTGRESQL rather than throwing', () => {
    // Documents the actual behaviour: an unrecognised provider string gets the Postgres driver. It is
    // the most permissive choice and it means a typo surfaces as a connection error, never as a crash
    // during connector construction.
    expect(getDbProtocolFamily('TOTALLY_UNKNOWN')).toBe('POSTGRESQL')
    expect(getDbProtocolFamily('')).toBe('POSTGRESQL')
  })

  test('CLICKHOUSE resolves to CLICKHOUSE (it is a real preset, not a fallback)', () => {
    // A guard against the fallback masking a real provider: CLICKHOUSE must come from the preset row.
    expect(getDbProtocolFamily('CLICKHOUSE')).toBe('CLICKHOUSE')
    expect(getDbProviderPreset('CLICKHOUSE')).toBeDefined()
  })
})

describe('getVectorStoreBackend', () => {
  test('resolves every preset id to its declared backend', () => {
    for (const preset of VECTOR_STORE_PRESETS) {
      expect(getVectorStoreBackend(preset.id)).toBe(preset.backend)
    }
  })

  test('the two Qdrant entries share ONE backend despite different ids', () => {
    // QDRANT and QDRANT_CLOUD differ only in auth and URL, so a client code path keyed on the backend
    // must treat them identically.
    expect(getVectorStoreBackend('QDRANT')).toBe('QDRANT')
    expect(getVectorStoreBackend('QDRANT_CLOUD')).toBe('QDRANT')
  })

  test('an unknown provider returns the id UNCHANGED', () => {
    // Deliberately different from getDbProtocolFamily: there is no safe default vector backend, so an
    // unknown value is passed through for the caller to reject rather than silently becoming INTERNAL.
    expect(getVectorStoreBackend('NOPE')).toBe('NOPE')
  })

  test('INTERNAL is the pgvector path and needs no API key', () => {
    expect(getVectorStoreBackend('INTERNAL')).toBe('INTERNAL')
    expect(getVectorStorePreset('INTERNAL')!.needsApiKey).toBe(false)
  })
})

describe('preset lookups and the exported id lists', () => {
  test('getDbProviderPreset returns undefined for an unknown id', () => {
    expect(getDbProviderPreset('NOPE')).toBeUndefined()
    expect(getDbProviderPreset('SUPABASE')?.id).toBe('SUPABASE')
  })

  test('getVectorStorePreset returns undefined for an unknown id', () => {
    expect(getVectorStorePreset('NOPE')).toBeUndefined()
  })

  test('VALID_*_IDS stay in sync with the preset tables', () => {
    // These arrays are what the API routes validate against; a drift would let the UI offer a provider
    // the server rejects (or reject one it offers).
    expect(VALID_DB_PROVIDER_IDS).toEqual(DB_PROVIDER_PRESETS.map((p) => p.id))
    expect(VALID_VECTOR_STORE_PROVIDER_IDS).toEqual(VECTOR_STORE_PRESETS.map((p) => p.id))
    expect(VALID_DB_PROVIDER_IDS).toContain('SUPABASE')
    expect(VALID_VECTOR_STORE_PROVIDER_IDS).toContain('CHROMA')
  })

  test('every preset id is unique (a duplicate would shadow the later row)', () => {
    expect(new Set(VALID_DB_PROVIDER_IDS).size).toBe(VALID_DB_PROVIDER_IDS.length)
    expect(new Set(VALID_VECTOR_STORE_PROVIDER_IDS).size).toBe(VALID_VECTOR_STORE_PROVIDER_IDS.length)
  })

  test('managed providers default to TLS', () => {
    // Every cloud/managed provider must opt in to TLS by default; a local one must not need to.
    for (const id of ['SUPABASE', 'NEON', 'PLANETSCALE', 'TIDB', 'COCKROACHDB']) {
      expect(getDbProviderPreset(id)!.sslByDefault).toBe(true)
    }
    expect(getDbProviderPreset('POSTGRESQL')!.sslByDefault).toBeUndefined()
  })
})
