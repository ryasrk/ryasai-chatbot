import { describe, expect, test } from 'bun:test'
import { describeSchema, type ReflectedTable } from './connectors'

describe('describeSchema', () => {
  test('renders PK, NOT NULL, FK, and distinct values', () => {
    const tables: ReflectedTable[] = [
      {
        tableName: 'orders',
        rowCount: 100,
        columns: [
          { name: 'id', type: 'INTEGER', primaryKey: true, notNull: true },
          { name: 'customer_id', type: 'INTEGER', notNull: true, foreignKey: 'customers.id' },
          { name: 'status', type: 'TEXT', distinctValues: ['pending', 'paid', 'shipped'] },
          { name: 'total', type: 'REAL' },
        ],
      },
    ]

    const out = describeSchema(tables)
    expect(out).toContain('PK: id')
    expect(out).toContain('id INTEGER PRIMARY KEY')
    expect(out).toContain('customer_id INTEGER NOT NULL -> customers.id')
    expect(out).toContain('status TEXT  -- values: pending, paid, shipped')
    expect(out).toContain('total REAL')
  })

  test('omits PK label when no primary key', () => {
    const tables: ReflectedTable[] = [
      {
        tableName: 'view_x',
        rowCount: 5,
        columns: [
          { name: 'a', type: 'TEXT' },
          { name: 'b', type: 'INTEGER' },
        ],
      },
    ]
    const out = describeSchema(tables)
    expect(out).not.toContain('PK:')
    expect(out).toContain('a TEXT')
    expect(out).toContain('b INTEGER')
  })

  test('renders sample row as comment', () => {
    const tables: ReflectedTable[] = [
      {
        tableName: 'orders',
        rowCount: 10,
        columns: [
          { name: 'id', type: 'INTEGER', primaryKey: true },
          { name: 'status', type: 'TEXT' },
          { name: 'total', type: 'REAL' },
        ],
        sampleRow: { id: 1001, status: 'delivered', total: 18500000 },
      },
    ]
    const out = describeSchema(tables)
    expect(out).toContain('-- sample: id=1001, status=\'delivered\', total=18500000')
  })

  test('truncates long string values in sample row', () => {
    const longStr = 'A'.repeat(50)
    const tables: ReflectedTable[] = [
      {
        tableName: 't',
        rowCount: 1,
        columns: [{ name: 'desc', type: 'TEXT' }],
        sampleRow: { desc: longStr },
      },
    ]
    const out = describeSchema(tables)
    expect(out).toContain("desc='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA...'")
    expect(out).not.toContain(longStr + "'")
  })
})
