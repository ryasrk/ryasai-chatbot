import { describe, expect, test } from 'bun:test'
import {
  buildSmartMappingPrompt,
  mergeSmartMapping,
  normalizeSmartMapping,
  normalizeSmartMappingUpdate,
} from './smart-mapping'

describe('smart mapping helpers', () => {
  test('normalizes AI mapping output with synonyms and routing hint', () => {
    const mapping = normalizeSmartMapping({
      entityType: 'inventory',
      routingHint: 'SQL',
      fields: [{ source: 'qty_on_hand', canonical: 'quantity' }],
      synonyms: ['stok', 'stock'],
    })

    expect(mapping.entityType).toBe('inventory')
    expect(mapping.routingHint).toBe('SQL')
    expect(mapping.fields[0]).toEqual({ source: 'qty_on_hand', canonical: 'quantity' })
    expect(mapping.synonyms).toContain('stok')
  })

  test('builds a compact mapping prompt from source metadata', () => {
    const prompt = buildSmartMappingPrompt({
      sourceType: 'DATABASE',
      sourceName: 'ERP',
      summary: 'tables: demo_inventory(sku, quantity)',
    })

    expect(prompt).toContain('DATABASE')
    expect(prompt).toContain('demo_inventory')
    expect(prompt).toContain('JSON')
  })

  test('keeps inferred entity when AI returns generic mapping', () => {
    const merged = mergeSmartMapping(
      normalizeSmartMapping({
        entityType: 'general',
        routingHint: 'SQL',
        fields: [],
        synonyms: ['stock'],
      }),
      normalizeSmartMapping({
        entityType: 'inventory',
        routingHint: 'SQL',
        fields: [{ source: 'sku', canonical: 'sku' }],
        synonyms: ['stok'],
      }),
    )

    expect(merged.entityType).toBe('inventory')
    expect(merged.synonyms).toContain('stock')
    expect(merged.synonyms).toContain('stok')
  })

  test('normalizes editable mapping update payload', () => {
    const update = normalizeSmartMappingUpdate({
      sourceName: '  ERP  ',
      entityType: ' Inventory ',
      routingHint: 'sql',
      synonyms: 'stok, stock, stok',
      fieldsText: 'qty_on_hand=quantity\nwarehouse:gudang',
      status: 'disabled',
    })

    expect(update).toEqual({
      sourceName: 'ERP',
      entityType: 'Inventory',
      routingHint: 'SQL',
      synonyms: ['stok', 'stock'],
      fields: [
        { source: 'qty_on_hand', canonical: 'quantity' },
        { source: 'warehouse', canonical: 'gudang' },
      ],
      status: 'disabled',
    })
  })
})
