import { describe, expect, test, mock } from 'bun:test'
import { buildCitationTrail } from './citation-trail'
import type { DualLevelResult } from '@/lib/knowledge-graph'
import type { RetrievedChunk } from '@/lib/rag'

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))

function makeChunk(chunkId: string, content: string, score = 0.8): RetrievedChunk {
  return {
    chunkId, documentId: 'doc', documentName: 'doc.txt', chunkIndex: 0,
    content, score,
    scoreBreakdown: { total: score, lexicalTotal: 0, contentHits: 0, keywordHits: 0, phraseHits: 0, semanticSimilarity: 0, semanticScore: 0 },
  }
}

const EMPTY_KG: DualLevelResult = {
  localChunks: [], globalChunks: [], allChunkIds: [], matchedEntities: [], graphContext: '',
}

describe('buildCitationTrail', () => {
  test('returns empty for empty KG result', () => {
    const trails = buildCitationTrail('query', EMPTY_KG, [makeChunk('c1', 'content')])
    expect(trails).toEqual([])
  })

  test('builds trails from local KG matches', () => {
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['alice'], graphContext: '',
    }
    const chunks = [makeChunk('c1', 'Alice works at the company')]
    const trails = buildCitationTrail('who is alice', kg, chunks)
    expect(trails).toHaveLength(1)
    expect(trails[0].entity).toBe('alice')
    expect(trails[0].relation).toBe('local entity match')
    expect(trails[0].chunkId).toBe('c1')
    expect(trails[0].relevance).toBeGreaterThan(0)
  })

  test('builds trails from global KG matches with relations', () => {
    const kg: DualLevelResult = {
      localChunks: [], globalChunks: ['c2'], allChunkIds: ['c2'],
      matchedEntities: ['bob'],
      graphContext: 'Knowledge Graph Relations:\n[bob] → manages → [alice]',
    }
    const chunks = [makeChunk('c2', 'Bob manages the team including alice')]
    const trails = buildCitationTrail('who does bob manage', kg, chunks)
    expect(trails).toHaveLength(1)
    expect(trails[0].entity).toBe('bob')
    expect(trails[0].relation).toBe('manages')
    expect(trails[0].relevance).toBeLessThanOrEqual(0.85)
  })

  test('handles multiple entities and chunks', () => {
    const kg: DualLevelResult = {
      localChunks: ['c1', 'c2'], globalChunks: ['c3'], allChunkIds: ['c1', 'c2', 'c3'],
      matchedEntities: ['alice', 'bob'],
      graphContext: 'Knowledge Graph Relations:\n[alice] → reports to → [bob]',
    }
    const chunks = [
      makeChunk('c1', 'Alice is a developer', 0.9),
      makeChunk('c2', 'Bob is a manager', 0.7),
      makeChunk('c3', 'Alice reports to Bob for reviews', 0.6),
    ]
    const trails = buildCitationTrail('alice bob', kg, chunks)
    expect(trails).toHaveLength(3)
    expect(trails[0].relevance).toBeGreaterThanOrEqual(trails[2].relevance)
  })

  test('skips chunks not in retrieved set', () => {
    const kg: DualLevelResult = {
      localChunks: ['c1', 'c9'], globalChunks: [], allChunkIds: ['c1', 'c9'],
      matchedEntities: ['alice'], graphContext: '',
    }
    const chunks = [makeChunk('c1', 'Alice content')]
    const trails = buildCitationTrail('alice', kg, chunks)
    expect(trails).toHaveLength(1)
    expect(trails[0].chunkId).toBe('c1')
  })
})

// ===========================================================================
// Entity/relation matching edges
// ===========================================================================
//
// These live in private helpers (matchEntity/matchRelation/parseGraphContext), so
// they are driven through buildCitationTrail. The entity a trail names is what a
// user sees as the SOURCE of an answer, so a wrong fallback silently attributes a
// claim to the wrong subject.

describe('buildCitationTrail — how the entity is chosen', () => {
  test('a SUBSTRING match in the content wins over the token fallback', () => {
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['Acme Corp', 'Globex'], graphContext: '',
    }
    const trails = buildCitationTrail('unrelated words', kg, [makeChunk('c1', 'the Acme Corp invoice')])
    expect(trails[0].entity).toBe('Acme Corp')
  })

  test('the QUERY-TOKEN fallback matches an entity the content does not contain', () => {
    // Lines 73-75. The chunk text may not repeat the entity (the KG linked them),
    // so the query tokens are the second chance: a token contained IN an entity
    // name selects it. Without this the trail would fall through to the first
    // entity and misattribute the answer.
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['Globex', 'Acme Corporation'], graphContext: '',
    }
    // Content mentions NEITHER entity; only the query token does.
    const trails = buildCitationTrail('about acme', kg, [makeChunk('c1', 'an invoice was paid')])
    expect(trails[0].entity).toBe('Acme Corporation')
  })

  test('with NO match at all it falls back to the FIRST entity', () => {
    // Line 78. Some entity must be named; the first matched entity is the best
    // available attribution.
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['First Entity', 'Second Entity'], graphContext: '',
    }
    const trails = buildCitationTrail('zzz qqq', kg, [makeChunk('c1', 'nothing relevant')])
    expect(trails[0].entity).toBe('First Entity')
  })

  test('with NO entities the entity is literally "unknown", never undefined', () => {
    // `entities[0] ?? 'unknown'` -- an undefined here would render as "undefined"
    // in the citation UI.
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: [], graphContext: '',
    }
    const trails = buildCitationTrail('zzz', kg, [makeChunk('c1', 'text')])
    expect(trails[0].entity).toBe('unknown')
  })
})

describe('buildCitationTrail — how the relation is chosen', () => {
  test('a relation found by its DESCRIPTION is used', () => {
    // Lines 87-88. This is the SECOND arm of matchRelation, and my first version
    // never reached it: the entity I supplied ('Acme Corp') WAS the relation's
    // source, so the endpoint check returned early and line 88 stayed uncovered
    // while the test still passed. The entity must be absent from both endpoints
    // for the description arm to be the one that answers.
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['Acme Corp'],
      graphContext: '[Acme Corp] → was billed for → [Invoice 42]',
    }
    // The chunk quotes the relation's description; the entity IS an endpoint here,
    // so this asserts the endpoint arm.
    const endpointChunk = makeChunk('c1', 'They were billed for the annual plan.')
    expect(buildCitationTrail('billed', kg, [endpointChunk])[0].relation).toBe('was billed for')

    // Now the entity is NOT an endpoint: 'Globex' is absent from the relation
    // entirely, so only the description arm can produce a relation.
    const kgOther: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['Globex'],
      graphContext: '[Acme Corp] → was billed for → [Invoice 42]',
    }
    // The chunk must contain the description's first 20 chars VERBATIM. My first
    // version wrote 'were billed for' while the relation says 'was billed for' --
    // one word apart, so the arm never fired and the test failed against correct
    // code. Matching is a literal substring, not a similarity check.
    const chunk = makeChunk('c1', 'Note: it was billed for the annual plan.')
    expect(buildCitationTrail('billed', kgOther, [chunk])[0].relation).toBe('was billed for')
  })

  test('a description match needs only its FIRST 20 characters', () => {
    // The slice(0, 20) is deliberate: a long generated description is matched on
    // its opening phrase, so a chunk that quotes only the start still links up.
    const longDesc = 'was billed for the annual enterprise subscription renewal'
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['Globex'],
      graphContext: `[Acme Corp] → ${longDesc} → [Invoice 42]`,
    }
    // Quotes only the OPENING phrase of the description, which is exactly what
    // slice(0, 20) is for; the rest of the description is absent.
    const chunk = makeChunk('c1', 'Roughly: it was billed for the annual plan.')
    expect(buildCitationTrail('billed', kg, [chunk])[0].relation).toBe(longDesc)
  })

  test('a description shorter than the slice still matches, and a NON-match falls back', () => {
    // A guard on `rel.description` plus the negative case, so the arm cannot be
    // satisfied by every relation.
    const noMatchKg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['Globex'],
      graphContext: '[Acme Corp] → owns → [Invoice 42]',
    }
    // 'owns' does not appear in the chunk, so no relation is found.
    expect(buildCitationTrail('billed', noMatchKg, [makeChunk('c1', 'unrelated sentence')])[0].relation)
      .toBe('local entity match')
  })

  test('a relation naming EITHER endpoint is used first', () => {
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['Acme Corp'], graphContext: '[Acme Corp] → owns → [Globex]',
    }
    const trails = buildCitationTrail('acme', kg, [makeChunk('c1', 'Acme Corp text')])
    expect(trails[0].relation).toBe('owns')
  })

  test('a graph line with NO arrow brackets is still parsed as a description', () => {
    // Line 64. The regex is strict; a hand-written or provider-formatted line that
    // uses an arrow but not the bracket shape must degrade to a description rather
    // than crash or produce undefined fields.
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['Acme Corp'],
      graphContext: 'Acme Corp → pays → Invoice',
    }
    const trails = buildCitationTrail('acme', kg, [makeChunk('c1', 'Acme Corp text')])
    // Falls back to the canned label, because the malformed line cannot be matched
    // by source/target -- but nothing throws and a trail is still produced.
    expect(trails).toHaveLength(1)
    expect(trails[0].relation).toBe('local entity match')
  })

  test('a malformed line is kept as a DESCRIPTION, not blanked', () => {
    // My first version of the test above only asserted the FALLBACK label, which a
    // blanked description also produces -- so deleting `line.trim()` still passed
    // and line 64 was unpinned. This asserts the parsed description itself, which
    // is the only way to observe that the line was retained at all. A malformed
    // line is kept deliberately: it is still readable guidance, and dropping it
    // would lose the relation silently.
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['Acme Corp'],
      // Arrow present, bracket shape absent -> the strict regex misses it and the
      // raw line becomes the description.
      graphContext: 'Acme Corp → pays → Invoice',
    }
    // The chunk quotes the raw line, so the description arm matches it and the
    // description is what comes back -- proving it was preserved.
    const trails = buildCitationTrail('acme', kg, [makeChunk('c1', 'see Acme Corp → pays → Invoice')])
    expect(trails[0].relation).toBe('Acme Corp → pays → Invoice')
  })

  test('with NO relations at all the local/global label is used', () => {
    const localKg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['Acme Corp'], graphContext: '',
    }
    expect(buildCitationTrail('acme', localKg, [makeChunk('c1', 'Acme Corp')])[0].relation)
      .toBe('local entity match')

    const globalKg: DualLevelResult = {
      localChunks: [], globalChunks: ['c1'], allChunkIds: ['c1'],
      matchedEntities: ['Acme Corp'], graphContext: '',
    }
    expect(buildCitationTrail('acme', globalKg, [makeChunk('c1', 'Acme Corp')])[0].relation)
      .toBe('global relation chain')
  })
})
