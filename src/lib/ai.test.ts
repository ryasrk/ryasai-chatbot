import { describe, expect, test } from 'bun:test'
import { answerContextLabel, REST_ROUTER_SYSTEM_PROMPT } from './ai'

describe('AI answer prompt helpers', () => {
  test('labels REST API context as REST API, not RAG', () => {
    expect(answerContextLabel('REST_API')).toBe('REST API')
  })

  test('treats REST sample responses as schema examples, not final data', () => {
    expect(REST_ROUTER_SYSTEM_PROMPT).toContain('sampleResponse hanya contoh struktur')
  })

  test('does not invent REST parameters without a parameter schema', () => {
    expect(REST_ROUTER_SYSTEM_PROMPT).toContain('Jangan kirim query atau body jika parameterSchema kosong')
  })
})
