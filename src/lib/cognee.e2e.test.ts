/**
 * Cognee E2E Test — Full flow: upload → cognify → chat → recall → memory → answer → follow-up
 * ----------------------------------------------------------------------------
 * Uses 15 Wikipedia articles (960KB, ~148K words) fetched from the Wikipedia API.
 * Tests the real cognee pipeline: entity extraction, knowledge graph build,
 * graph-grounded retrieval, chat memory write/recall, cross-session memory.
 *
 * Requirements:
 *   - LLM config in DB (for cognify entity extraction + chat answer generation)
 *   - COGNEE_ENABLED=true or AppConfig.cogneeEnabled=true
 *   - No dev server running (Kuzu file lock — or use separate COGNEE_DATA_DIR)
 *
 * Run: bun test src/lib/cognee.e2e.test.ts
 */
import { beforeAll, afterAll, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import { db } from '@/lib/db'
import {
  cognifyBatch,
  recallKnowledgeGraph,
  rememberChatTurn,
  recallContext,
  forgetKnowledgeGraph,
  invalidateCogneeSettings,
} from './cognee'
import { retrieveRelevantChunks, chunkText } from './rag'
import { runNonStreamingChatCompletion } from './tool-router'

const COGNEE_E2E_ENABLED = process.env.RUN_COGNEE_E2E === 'true'
const maybeDescribe = COGNEE_E2E_ENABLED ? describe : describe.skip

const COGNEE_TEST_DATA = '.cognee-e2e/data'
const COGNEE_TEST_SYSTEM = '.cognee-e2e/system'
const TEST_DOC_PREFIX = 'e2e-wiki-'
const TEST_SESSION_ID = 'e2e-test-session-001'
const TEST_USER_ID = 'usr-admin'

const TEST_ARTICLES = [
  'Apple_Inc',
  'Steve_Jobs',
  'Microsoft',
  'Alan_Turing',
  'Artificial_intelligence',
]

let testDocIds: string[] = []

beforeAll(async () => {
  if (!COGNEE_E2E_ENABLED) return
  process.env.COGNEE_DATA_DIR = COGNEE_TEST_DATA
  process.env.COGNEE_SYSTEM_DIR = COGNEE_TEST_SYSTEM
  process.env.COGNEE_ENABLED = 'true'

  const config = await db.appConfig.findFirst()
  if (config) {
    await db.appConfig.update({
      where: { id: config.id },
      data: { cogneeEnabled: true },
    })
  } else {
    await db.appConfig.create({ data: { cogneeEnabled: true } })
  }
  invalidateCogneeSettings()

  const existing = await db.document.findMany({
    where: { name: { startsWith: TEST_DOC_PREFIX } },
    select: { id: true },
  })
  for (const doc of existing) {
    await db.documentChunk.deleteMany({ where: { documentId: doc.id } }).catch(() => {})
    await db.document.delete({ where: { id: doc.id } }).catch(() => {})
  }

  if (fs.existsSync(COGNEE_TEST_SYSTEM)) {
    fs.rmSync(COGNEE_TEST_SYSTEM, { recursive: true, force: true })
  }
  if (fs.existsSync(COGNEE_TEST_DATA)) {
    fs.rmSync(COGNEE_TEST_DATA, { recursive: true, force: true })
  }
})

afterAll(async () => {
  if (!COGNEE_E2E_ENABLED) return
  for (const docId of testDocIds) {
    await db.documentChunk.deleteMany({ where: { documentId: docId } }).catch(() => {})
    await db.document.delete({ where: { id: docId } }).catch(() => {})
  }
  await forgetKnowledgeGraph().catch(() => {})
  try {
    if (fs.existsSync(COGNEE_TEST_SYSTEM)) {
      fs.rmSync(COGNEE_TEST_SYSTEM, { recursive: true, force: true })
    }
    if (fs.existsSync(COGNEE_TEST_DATA)) {
      fs.rmSync(COGNEE_TEST_DATA, { recursive: true, force: true })
    }
  } catch {}

  delete process.env.COGNEE_DATA_DIR
  delete process.env.COGNEE_SYSTEM_DIR
  invalidateCogneeSettings()
})

maybeDescribe('cognee e2e: upload → cognify → chat → recall → memory → answer', () => {
  test(
    'Phase 1: Upload 5 Wikipedia articles + cognify knowledge graph',
    async () => {
      const wikiDir = path.join(process.cwd(), 'test-data', 'wikipedia')
      const documents: Array<{
        documentId: string
        documentName: string
        chunks: Array<{ content: string; chunkIndex: number }>
      }> = []

      for (const articleName of TEST_ARTICLES) {
        const filePath = path.join(wikiDir, `${articleName}.txt`)
        expect(fs.existsSync(filePath)).toBe(true)

        const fullContent = fs.readFileSync(filePath, 'utf-8')
        const truncated = fullContent.slice(0, 6000)
        const chunks = chunkText(truncated)

        expect(chunks.length).toBeGreaterThan(0)

        const doc = await db.document.create({
          data: {
            name: `${TEST_DOC_PREFIX}${articleName}`,
            type: 'txt',
            sizeBytes: truncated.length,
            mimeType: 'text/plain',
            status: 'ready',
            contentText: truncated,
            chunks: {
              create: chunks.map((content, idx) => ({
                chunkIndex: idx,
                content,
                tokenCount: Math.floor(content.length / 4),
              })),
            },
          },
        })

        testDocIds.push(doc.id)
        documents.push({
          documentId: doc.id,
          documentName: doc.name,
          chunks: chunks.map((content, idx) => ({ content, chunkIndex: idx })),
        })
      }

      expect(documents.length).toBe(5)

      const result = await cognifyBatch({ documents })
      console.log('Cognify result:', JSON.stringify(result))

      expect(result.processed).toBeGreaterThan(0)
      expect(result.failed).toBe(0)

      const docs = await db.document.findMany({
        where: { id: { in: testDocIds } },
        select: { name: true, cognifyStatus: true },
      })
      for (const doc of docs) {
        console.log(`  ${doc.name}: ${doc.cognifyStatus}`)
        expect(doc.cognifyStatus).toBe('completed')
      }
    },
    600000,
  )

  test(
    'Phase 2: Knowledge graph recall returns entity-rich context',
    async () => {
      const result = await recallKnowledgeGraph({ query: 'Who founded Apple?', topK: 5 })

      console.log('Graph recall (first 300 chars):', result.slice(0, 300))

      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    },
    60000,
  )

  test(
    'Phase 3: RAG retrieval includes graph-grounded context',
    async () => {
      const retrieval = await retrieveRelevantChunks({
        query: 'Who founded Apple?',
        topK: 4,
      })

      console.log('Chunks found:', retrieval.chunks.length)
      console.log('Graph context (first 200 chars):', retrieval.graphContext.slice(0, 200))

      expect(retrieval.chunks.length).toBeGreaterThan(0)
      expect(retrieval.graphContext.length).toBeGreaterThan(0)
    },
    60000,
  )

  test(
    'Phase 4: Chat answer is grounded in document + graph data',
    async () => {
      const result = await runNonStreamingChatCompletion({
        question: 'Who founded Apple Inc.?',
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
      })

      console.log('Answer (first 400 chars):', result.answer.slice(0, 400))
      console.log('Citations:', result.citations.length)
      console.log('Tool runs:', result.toolRuns.map((t) => t.type).join(', '))

      expect(result.answer.length).toBeGreaterThan(0)

      const answerLower = result.answer.toLowerCase()
      const mentionsJobs = answerLower.includes('jobs') || answerLower.includes('steve')
      const mentionsWozniak = answerLower.includes('wozniak')
      const mentionsApple = answerLower.includes('apple')

      expect(mentionsApple).toBe(true)
      expect(mentionsJobs || mentionsWozniak).toBe(true)
    },
    120000,
  )

  test(
    'Phase 5: Memory write (rememberChatTurn) + recall (recallContext)',
    async () => {
      await rememberChatTurn({
        sessionId: TEST_SESSION_ID,
        userMessage: 'Who founded Apple Inc.?',
        aiMessage:
          'Apple Inc. was founded by Steve Jobs, Steve Wozniak, and Ronald Wayne in 1976 in Cupertino, California.',
        toolRuns: [{ type: 'RAG', status: 'success', latencyMs: 150 }],
      })

      await new Promise((resolve) => setTimeout(resolve, 5000))

      const recalled = await recallContext({
        query: 'Apple founder',
        sessionId: TEST_SESSION_ID,
      })

      console.log('Recalled memory (first 300 chars):', recalled.slice(0, 300))

      expect(typeof recalled).toBe('string')
      expect(recalled.length).toBeGreaterThan(0)
    },
    60000,
  )

  test(
    'Phase 6: Cross-session memory recall (different sessionId)',
    async () => {
      const recalled = await recallContext({
        query: 'When was Apple founded and by whom?',
        sessionId: 'e2e-different-session-999',
      })

      console.log('Cross-session recall (first 300 chars):', recalled.slice(0, 300))

      expect(typeof recalled).toBe('string')
      expect(recalled.length).toBeGreaterThan(0)
    },
    60000,
  )

  test(
    'Phase 7: Follow-up question uses prior context for multi-hop reasoning',
    async () => {
      const result = await runNonStreamingChatCompletion({
        question: 'What other company did the Apple founder create after leaving Apple?',
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        chatHistory: [
          {
            role: 'user',
            content: 'Who founded Apple Inc.?',
          },
          {
            role: 'assistant',
            content:
              'Apple Inc. was founded by Steve Jobs, Steve Wozniak, and Ronald Wayne in 1976.',
          },
        ],
      })

      console.log('Follow-up answer (first 400 chars):', result.answer.slice(0, 400))

      expect(result.answer.length).toBeGreaterThan(0)

      const answerLower = result.answer.toLowerCase()
      const mentionsNeXT = answerLower.includes('next')
      const mentionsPixar = answerLower.includes('pixar')
      const mentionsJobs = answerLower.includes('jobs') || answerLower.includes('steve')

      expect(mentionsJobs).toBe(true)
      expect(mentionsNeXT || mentionsPixar).toBe(true)
    },
    120000,
  )

  test(
    'Phase 8: Graph recall for different entity (Alan Turing → AI)',
    async () => {
      const result = await recallKnowledgeGraph({
        query: 'What is Alan Turing contribution to artificial intelligence?',
        topK: 5,
      })

      console.log('Turing graph recall (first 300 chars):', result.slice(0, 300))

      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    },
    60000,
  )
})
