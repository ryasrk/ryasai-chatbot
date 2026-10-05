import { describe, expect, test } from 'bun:test'
import { rerankWindow, RERANK_WINDOW_CHARS } from './rerank-window'

// Shape of the q179 chunk (risk-02-asuransi-klaim.md #3): the asked-for row sits far past the first 300 characters.
const TABLE = [
  '#### Table 1: Insurance Coverage Limits and Deductibles',
  '| Scope | Asset / Facility Code | Fleet or Facility Details | Policy Limit (IDR) | Deductible per Incident (IDR) |',
  '| :--- | :--- | :--- | :--- | :--- |',
  '| Transit Fleet | Vans (58 units) | Blind vans / last-mile | 250,000,000 per conveyance | 5% of claim |',
  '| Transit Fleet | CDE (96 units) | Colt Diesel Engkel (4 wheels) | 500,000,000 per conveyance | 5% of claim |',
  '| Transit Fleet | CDD (140 units) | Colt Diesel Double (6 wheels) | 1,000,000,000 per conveyance | 5% of claim |',
  '| Transit Fleet | Fuso (52 units) | Medium-duty cargo trucks | 2,500,000,000 per conveyance | 5% of claim |',
  '| Warehouse | SBY-01 Surabaya | Hub warehouse (18,000 m²) | 85,000,000,000 per location | 10% of claim |',
  '| Warehouse | JKT-02 Cikarang | Regional hub (24,500 m²) | 120,000,000,000 per location | 10% of claim |',
  '| Warehouse | MDN-03 Medan | Regional hub (9,200 m²) | 45,000,000,000 per location | 10% of claim |',
].join('\n')

describe('rerankWindow', () => {
  test('shows the row the query asks about, with the heading and the column header', () => {
    expect(TABLE.slice(0, RERANK_WINDOW_CHARS)).not.toContain('JKT-02') // what the reranker used to see
    const w = rerankWindow(TABLE, 'cargo insurance policy limit for the Cikarang warehouse')
    expect(w).toContain('JKT-02 Cikarang')
    expect(w).toContain('120,000,000,000')
    expect(w.startsWith('#### Table 1: Insurance Coverage Limits')).toBe(true)
    expect(w).toContain('| Scope | Asset / Facility Code |')
  })

  test('a chunk whose opening is the best match is shown exactly as before', () => {
    const text = 'Annual leave is 12 days per year. ' + 'Unrelated filler sentence about parking. '.repeat(20)
    expect(rerankWindow(text, 'how many days of annual leave')).toBe(text.slice(0, RERANK_WINDOW_CHARS))
  })

  test('no query word anywhere (e.g. another language): the opening, as before', () => {
    expect(rerankWindow(TABLE, 'berapa batas polis')).toBe(TABLE.slice(0, RERANK_WINDOW_CHARS))
    expect(rerankWindow(TABLE, '')).toBe(TABLE.slice(0, RERANK_WINDOW_CHARS))
  })

  test('a short chunk is returned whole', () => {
    expect(rerankWindow('Short chunk.', 'anything')).toBe('Short chunk.')
  })

  test('prose: the window starts at the sentence holding the answer', () => {
    const text = 'General introduction to the access policy. '.repeat(10) + 'Unused accounts inactive for 45 consecutive days must be suspended automatically. Closing remarks.'
    const w = rerankWindow(text, 'automatic suspension threshold for inactive accounts')
    expect(w).toContain('Unused accounts inactive for 45 consecutive days')
    expect(w.split('\n…\n')[1].startsWith('Unused accounts')).toBe(true)
  })
})
