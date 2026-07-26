import { describe, expect, test } from 'bun:test'
import {
  buildDocumentCitation,
  buildChartDataFromRows,
  chooseAvailableDecision,
  parseRestCallJson,
} from './tool-router'

describe('tool router helpers', () => {
  test('falls back to CHAT when the selected route has no available data source', () => {
    expect(
      chooseAvailableDecision('SQL', {
        hasIntegrations: false,
        hasDocuments: true,
        hasRestApis: true,
      }),
    ).toBe('CHAT')

    expect(
      chooseAvailableDecision('REST', {
        hasIntegrations: true,
        hasDocuments: true,
        hasRestApis: false,
      }),
    ).toBe('CHAT')
  })

  test('builds a bar chart from label and numeric rows', () => {
    const chart = buildChartDataFromRows([
      { category: 'Accessories', total: 12 },
      { category: 'Electronics', total: 8 },
    ])

    expect(chart).toEqual({
      type: 'bar',
      data: [
        { category: 'Accessories', total: 12 },
        { category: 'Electronics', total: 8 },
      ],
      xKey: 'category',
      yKeys: ['total'],
    })
  })

  test('parses REST call selection JSON without markdown fences', () => {
    const parsed = parseRestCallJson(
      '```json\n{"endpointId":"ep_1","query":{"limit":5},"body":null,"explanation":"get customers"}\n```',
    )

    expect(parsed).toEqual({
      endpointId: 'ep_1',
      query: { limit: 5 },
      body: null,
      explanation: 'get customers',
    })
  })

  test('builds document citations with chunk index and snippet', () => {
    const citation = buildDocumentCitation({
      documentName: 'SOP.md',
      chunkIndex: 3,
      content: 'SLA payment invoice maximum 14 days.',
      score: 8,
    })

    expect(citation.source).toBe('SOP.md')
    expect(citation.query_used).toBe('chunk #3')
    expect(citation.snippet).toContain('SLA payment')
    expect(citation.score).toBe(8)
  })
})
