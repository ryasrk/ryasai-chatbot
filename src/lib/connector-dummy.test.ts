/**
 * Dummy DB connection test — validates the real PostgreSQL connector end-to-end
 * against a scratch schema in local Postgres (acts as a dummy remote server).
 *
 * Run: DATABASE_URL=postgresql://ryasai:ryasai_dev@localhost:5432/ryasai bun test src/lib/connector-dummy.test.ts
 *
 * Exercises:
 *   1. testConnection()          → SELECT 1
 *   2. fetchSchema()             → information_schema reflection
 *   3. executeQuery()            → validated SQL against reflected tables
 *   4. registry drop()           → pool cleanup
 */
import { test, expect } from 'bun:test'
import { connectorRegistry } from './connectors'

const INTEGRATION_ID = 'dummy-integration-test'
const SCHEMA = 'dummy_test'

// Connector config pointing at the scratch schema (as if it were a remote server).
const config = {
  host: 'localhost',
  port: 5432,
  username: 'ryasai',
  password: 'ryasai_dev',
  database_name: 'ryasai',
  schema: SCHEMA,
}

test('connector: testConnection succeeds', async () => {
  const c = connectorRegistry.getConnector(INTEGRATION_ID, 'POSTGRESQL', config)
  const ok = await c.testConnection()
  expect(ok).toBe(true)
  await c.close?.()
  connectorRegistry.drop(INTEGRATION_ID)
})

test('connector: fetchSchema reflects dummy tables', async () => {
  const c = connectorRegistry.getConnector(INTEGRATION_ID + '-2', 'POSTGRESQL', config)
  const tables = await c.fetchSchema()
  const names = tables.map((t) => t.tableName)
  expect(names).toContain('products')
  expect(names).toContain('customers')

  const products = tables.find((t) => t.tableName === 'products')!
  const colNames = products.columns.map((col) => col.name)
  expect(colNames).toContain('id')
  expect(colNames).toContain('name')
  expect(colNames).toContain('price')
  expect(products.rowCount).toBe(2)
  expect(products.sampleRow).toBeTruthy()
  await c.close?.()
  connectorRegistry.drop(INTEGRATION_ID + '-2')
})

test('connector: executeQuery runs validated SQL on reflected table', async () => {
  const c = connectorRegistry.getConnector(INTEGRATION_ID + '-3', 'POSTGRESQL', config)
  const res = await c.executeQuery(`SELECT name, price FROM dummy_test.products ORDER BY price DESC`)
  expect(res.rowCount).toBe(2)
  expect(res.rows[0]).toMatchObject({ name: 'Laptop' })
  // pg returns NUMERIC as string — expected, not a bug
  expect(Number(res.rows[0].price)).toBe(1500)
  expect(res.executionMs).toBeGreaterThanOrEqual(0)
  await c.close?.()
  connectorRegistry.drop(INTEGRATION_ID + '-3')
})
