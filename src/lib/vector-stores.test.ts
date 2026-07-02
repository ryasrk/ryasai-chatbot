import { describe, expect, test } from 'bun:test'
import {
  buildMilvusSearchBody,
  buildQdrantSearchBody,
  buildVectorPoint,
  parseMilvusSearchResponse,
  parseQdrantSearchResponse,
  vectorPointId,
} from './vector-stores'

describe('vector store helpers', () => {
  test('builds stable point ids and payloads', () => {
    const point = buildVectorPoint({
      chunkId: 'chunk_1',
      vector: [0.1, 0.2],
      payload: { companyId: 'cmp_1', documentId: 'doc_1' },
    })

    expect(vectorPointId('chunk_1')).toMatch(/^[0-9a-f-]{36}$/)
    expect(point.payload.chunkId).toBe('chunk_1')
  })

  test('builds Qdrant and Milvus search bodies with tenant filter', () => {
    expect(buildQdrantSearchBody([1, 2], 3, 'cmp_1')).toEqual({
      vector: [1, 2],
      limit: 3,
      with_payload: true,
      filter: { must: [{ key: 'companyId', match: { value: 'cmp_1' } }] },
    })

    expect(buildMilvusSearchBody('chunks', [1, 2], 3, 'cmp_1')).toMatchObject({
      collectionName: 'chunks',
      data: [[1, 2]],
      limit: 3,
      filter: 'companyId == "cmp_1"',
    })
  })

  test('parses Qdrant and Milvus search responses into chunk scores', () => {
    expect(
      parseQdrantSearchResponse({
        result: [{ score: 0.8, payload: { chunkId: 'chunk_1' } }],
      }),
    ).toEqual([{ chunkId: 'chunk_1', score: 0.8 }])

    expect(
      parseMilvusSearchResponse({
        data: [{ score: 0.7, entity: { chunkId: 'chunk_2' } }],
      }),
    ).toEqual([{ chunkId: 'chunk_2', score: 0.7 }])
  })
})
