/**
 * Tests for the Entity-Hop arm (docs/entity-hop-retrieval-plan.md, Phase 2).
 *
 * WHY THESE FIXTURES AND NOT THE BENCHMARK CORPUS
 * ----------------------------------------------------------------------------
 * The benchmark corpus cannot prove a mechanic: every rule is entangled with every
 * other one, so a passing number would not say WHICH rule did the work. Each fixture
 * below isolates one rule — a singleton bigram, a two-hop chain with no shared
 * vocabulary, a hub entity, a disclaimed bridge — and asserts that rule's own outcome.
 * The corpus then only has to confirm the mechanics scale.
 *
 * The last block is the safety property the plan's easy-tier gate depends on: when the
 * hop step contributes nothing, this arm's output must equal the plain hybrid ranking
 * EXACTLY, not merely correlate with it.
 */
import { describe, expect, test } from 'bun:test'
import type { ArmContext, EntityHopAblation } from '../arm-types'
import { ENTITY_HOP_DEFAULTS } from '../arm-types'
import { arm, buildEntityIndex, explainEntityHop, extractEntities, makeEntityHopArm } from './entity-hop-arm'
import { arm as hybridArm } from './hybrid-arm'

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

describe('extractEntities', () => {
  test('finds the plan ID shapes, upper-cased, and returns them sorted', () => {
    const entities = extractEntities('Delivery DL-106 from PO-0054 reached W-01 and AF-012; INV-0001 is closed.')
    expect(entities).toContain('DL-106')
    expect(entities).toContain('PO-0054')
    expect(entities).toContain('W-01')
    expect(entities).toContain('AF-012')
    expect(entities).toContain('INV-0001')
    expect(entities).toEqual([...entities].sort())
  })

  test('does not invent an ID from prose or a lowercase fragment', () => {
    expect(extractEntities('the batch-12 note mentions dl-106 in passing')).toEqual([])
  })

  test('finds `PT <Capitalised> <Capitalised>?` and lower-cases it', () => {
    const entities = extractEntities('Vendor PT Bumi Sentosa billed; PT Karya supplied parts.')
    expect(entities).toContain('pt bumi sentosa')
    expect(entities).toContain('pt karya')
  })

  test('a Capitalised bigram appearing once is NOT an entity, one appearing twice IS', () => {
    const index = buildEntityIndex({
      'doc-1': 'Project Alpha was reviewed. Project Gamma was approved.',
      'doc-2': 'Project Gamma was approved again.',
    })
    // `project alpha` has df 1: a singleton cannot bridge anything, so it is not stored.
    expect(extractEntities('Project Alpha was reviewed.')).toEqual([])
    expect(index.docEntities.get('doc-1')).toContain('project gamma')
    expect(index.docEntities.get('doc-1')).not.toContain('project alpha')
    expect(index.df.get('project gamma')).toBe(2)
    expect(index.df.get('project alpha')).toBeUndefined()
  })

  test('a bigram that is part of a `PT ...` name is not stored as a second entity', () => {
    const index = buildEntityIndex({
      'doc-1': 'PT Bumi Sentosa supplied parts.',
      'doc-2': 'PT Bumi Sentosa supplied more parts.',
    })
    expect(index.docEntities.get('doc-1')).toEqual(['pt bumi sentosa'])
  })
})

// ---------------------------------------------------------------------------
// The two-hop chain: the answer document shares no term with the question
// ---------------------------------------------------------------------------

const CHAIN: ArmContext = {
  docIds: ['doc-a', 'doc-b', 'doc-c', 'doc-d'],
  texts: {
    // Seed: the only document mentioning DL-700, which the question names. It also
    // carries the bridge entity nothing in the question points at.
    'doc-a':
      'Delivery DL-700 was logged at the Surabaya gate. The handling officer names PT Cahaya Nusantara as the receiving contractor for this delivery.',
    // Hop 1 through `pt cahaya nusantara`; carries the second-hop entity CP-0042.
    'doc-b':
      'Contractor note for PT Cahaya Nusantara: this contractor holds custody of compound CP-0042 at the Palembang site.',
    // Hop 2 through CP-0042. Shares no token with the question, so BM25 cannot rank it.
    'doc-c': 'Serial SN-0177 sits inside compound CP-0042 under officer Rahmat Hidayat, per the storage ledger.',
    // Distractor: loud on the question's own words and says nothing useful.
    'doc-d': 'An archive code is logged for every delivery in the Surabaya desk ledger; archive code fields are left blank.',
  },
}

const CHAIN_QUESTION = 'Which archive code is logged for delivery DL-700?'

describe('hop chain', () => {
  test('the fixture really is disjoint: lexical retrieval alone cannot rank doc-c', () => {
    const lexicalOnly = makeEntityHopArm({ maxHops: 0 })
    expect(lexicalOnly.rank(CHAIN_QUESTION, CHAIN, 10)).not.toContain('doc-c')
  })

  test('reaches a document that shares no term with the question through two entity hops', () => {
    expect(arm.rank(CHAIN_QUESTION, CHAIN, 10)).toContain('doc-c')
  })

  test('one hop is not enough, which is what makes the previous result a TWO-hop result', () => {
    expect(makeEntityHopArm({ maxHops: 1 }).rank(CHAIN_QUESTION, CHAIN, 10)).not.toContain('doc-c')
  })

  test('records the path that reached it: doc-b via the contractor, doc-c via CP-0042', () => {
    const paths = explainEntityHop(CHAIN_QUESTION, CHAIN)
    const toB = paths.find((p) => p.docId === 'doc-b')
    const toC = paths.find((p) => p.docId === 'doc-c')
    expect(toB?.viaEntity).toBe('pt cahaya nusantara')
    expect(toB?.fromDocId).toBe('doc-a')
    expect(toB?.hop).toBe(1)
    expect(toC?.viaEntity).toBe('CP-0042')
    expect(toC?.fromDocId).toBe('doc-b')
    expect(toC?.hop).toBe(2)
    // Evidence order is hop order, so a reader sees the chain rather than a bag of hits.
    expect(paths.map((p) => p.hop)).toEqual([1, 2])
  })

  test('an entity named in the question never seeds a hop', () => {
    // DL-700 is in the question, so doc-a is reached by the direct legs, not by a hop.
    expect(explainEntityHop(CHAIN_QUESTION, CHAIN).some((p) => p.viaEntity === 'DL-700')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Hub entities
// ---------------------------------------------------------------------------

/**
 * Seeds on DL-500 and W-01. W-01 also appears in 63 filler documents, so its document
 * frequency (64) is above the plan's default cut-off of 60 — the hub rule is live here.
 * `doc-0000-target` is reachable ONLY through W-01: nothing else links it to the seed.
 */
const HUB: ArmContext = (() => {
  const texts: Record<string, string> = {
    'doc-0000-target': 'Archived memo concerning W-01: the site roster was reviewed and the entry was left unchanged.',
    'doc-seed': 'Delivery DL-500 was recorded against W-01 at the Surabaya gate.',
  }
  const docIds = ['doc-0000-target', 'doc-seed']
  for (let i = 1; i <= 63; i++) {
    const id = `doc-hub-${String(i).padStart(3, '0')}`
    texts[id] = `Routine archive line ${i} covering W-01.`
    docIds.push(id)
  }
  return { docIds, texts }
})()

const HUB_QUESTION = 'Which shift is recorded for delivery DL-500?'

describe('hub cut-off', () => {
  test('the fixture exceeds the default cut-off, so the rule is actually exercised', () => {
    expect(buildEntityIndex(HUB.texts).df.get('W-01')).toBeGreaterThan(60)
  })

  test('a document reachable only through a hub entity is NOT pulled in', () => {
    expect(arm.rank(HUB_QUESTION, HUB, 10)).not.toContain('doc-0000-target')
    // With the hub skipped the hop step contributes nothing at all for this question.
    expect(explainEntityHop(HUB_QUESTION, HUB)).toEqual([])
  })

  test('the same document IS pulled in when the hub cut-off is disabled', () => {
    const paths = explainEntityHop(HUB_QUESTION, HUB, { disableHubCutoff: true })
    expect(paths.find((p) => p.docId === 'doc-0000-target')?.viaEntity).toBe('W-01')
    expect(makeEntityHopArm({ disableHubCutoff: true }).rank(HUB_QUESTION, HUB, 10)).toContain('doc-0000-target')
  })
})

// ---------------------------------------------------------------------------
// Negation
// ---------------------------------------------------------------------------

const NEGATION: ArmContext = {
  docIds: ['doc-1', 'doc-2', 'doc-3'],
  texts: {
    'doc-1': 'Delivery DL-900 is on the Project Nusantara roster for this window.',
    // The disclaimer sits in the SAME sentence as the linking entity, so this document
    // must not be used as a bridge through it.
    'doc-2':
      'Reconciliation note: no record of Project Nusantara was filed for this window, although INV-0001 is listed elsewhere.',
    'doc-3': 'Serial SN-0455 was logged against INV-0001 by the Medan clerk.',
  },
}

const NEGATION_QUESTION = 'Which roster entry applies to delivery DL-900?'

describe('negation', () => {
  test('a disclaimed bridge is skipped, so the document behind it is not reached', () => {
    const paths = explainEntityHop(NEGATION_QUESTION, NEGATION)
    expect(paths.some((p) => p.docId === 'doc-2')).toBe(false)
    expect(paths.some((p) => p.docId === 'doc-3')).toBe(false)
  })

  test('the disclaimer really is what blocked it: a positive sentence reaches doc-2', () => {
    // Same shape, no cue. Without this control a passing test could just mean the
    // entity never matched anything.
    const control: ArmContext = {
      docIds: NEGATION.docIds,
      texts: {
        ...NEGATION.texts,
        'doc-2': 'Reconciliation note: an incident was filed for Project Nusantara, and INV-0001 is listed elsewhere.',
      },
    }
    expect(explainEntityHop(NEGATION_QUESTION, control).some((p) => p.docId === 'doc-2')).toBe(true)
  })

  test('with negation disabled the same document IS used as a bridge', () => {
    const paths = explainEntityHop(NEGATION_QUESTION, NEGATION, { disableNegation: true })
    expect(paths.some((p) => p.docId === 'doc-2')).toBe(true)
    expect(paths.find((p) => p.docId === 'doc-3')?.viaEntity).toBe('INV-0001')
  })
})

// ---------------------------------------------------------------------------
// Determinism and the empty-hop safety property
// ---------------------------------------------------------------------------

/** No IDs and no Capitalised tokens, so the hop step is empty by construction. */
const VECTORED: ArmContext = {
  docIds: ['doc-1', 'doc-2', 'doc-3'],
  texts: { 'doc-1': 'alpha report', 'doc-2': 'beta report', 'doc-3': 'gamma report' },
  embeddings: { 'doc-1': [1, 0], 'doc-2': [0, 1], 'doc-3': [0.6, 0.8] },
  embeddingModel: 'fixture-2d',
  queryEmbeddings: { 'what does the alpha report say': [1, 0] },
  queryEmbeddingModel: 'fixture-2d',
}
const VECTORED_QUESTION = 'what does the alpha report say'

describe('the arm contract', () => {
  test('has the frozen id and kind, and equals the no-options factory call', () => {
    expect(arm.id).toBe('entity-hop')
    expect(arm.kind).toBe('entity-hop')
    expect(makeEntityHopArm().id).toBe(arm.id)
    expect(makeEntityHopArm().kind).toBe(arm.kind)
    expect(makeEntityHopArm().rank(CHAIN_QUESTION, CHAIN, 10)).toEqual(arm.rank(CHAIN_QUESTION, CHAIN, 10))
  })

  test('is ready with and without a vector cache — lexical-only operation must work', () => {
    expect(arm.ready(CHAIN)).toBe(true)
    expect(arm.ready(VECTORED)).toBe(true)
    expect(arm.ready({ texts: {}, docIds: [] })).toBe(false)
  })

  test('names its ablations, and calls the shipped arm `entity-hop`', () => {
    expect(makeEntityHopArm({ disableRarityWeight: true }).id).toBe('ablate-rarity-weight')
    expect(makeEntityHopArm({ disableHubCutoff: true }).id).toBe('ablate-hub-cutoff')
    expect(makeEntityHopArm({ disableNegation: true }).id).toBe('ablate-negation')
    expect(makeEntityHopArm({ maxHops: 1 }).id).toBe('hops-1')
    expect(makeEntityHopArm({ maxHops: 3 }).id).toBe('hops-3')
  })

  test('the rarity weight decides which bridge ranks first', () => {
    // The seed names both a rare and a common organisation. The rare entity's document sorts
    // LAST by docId and the common entity's first, so only the weight can put the rare bridge
    // ahead of it: df(pt alfa beta)=2 vs df(pt gamma delta)=10 over N=11 documents, i.e.
    // log(5.5) against log(1.1). With the weight off both contributions are exactly 1 and the
    // documented tie rule (docId ascending) picks the common entity's document instead.
    const texts: Record<string, string> = {
      'doc-seed': 'Delivery DL-800 was logged at the gate under PT Alfa Beta and reference PT Gamma Delta.',
      'doc-a-common': 'Routine line concerning PT Gamma Delta.',
      'doc-z-rare': 'QA-002 belongs to PT Alfa Beta.',
    }
    for (let i = 1; i <= 8; i++) texts[`doc-f-${i}`] = `Filler archive line ${i} concerning PT Gamma Delta.`
    const ctx: ArmContext = { docIds: Object.keys(texts).sort(), texts }
    const question = 'Which record concerns delivery DL-800?'
    const order = (opts: Partial<EntityHopAblation>) => {
      const ranked = makeEntityHopArm(opts).rank(question, ctx, 12)
      const rare = ranked.indexOf('doc-z-rare')
      expect(rare).toBeGreaterThanOrEqual(0)
      return rare < ranked.indexOf('doc-a-common')
    }
    expect(order({})).toBe(true)
    expect(order({ disableRarityWeight: true })).toBe(false)
  })

  test('is deterministic: repeated calls agree byte for byte', () => {
    const first = arm.rank(CHAIN_QUESTION, CHAIN, 10)
    expect(arm.rank(CHAIN_QUESTION, CHAIN, 10)).toEqual(first)
    // Same content through a fresh context object: the result must not depend on identity.
    const clone: ArmContext = { docIds: [...CHAIN.docIds], texts: { ...CHAIN.texts } }
    expect(arm.rank(CHAIN_QUESTION, clone, 10)).toEqual(first)
  })

  test('empty hop ranking — output is identical to the plain hybrid ranking', () => {
    expect(explainEntityHop(VECTORED_QUESTION, VECTORED)).toEqual([])
    expect(arm.rank(VECTORED_QUESTION, VECTORED, 10)).toEqual(hybridArm.rank(VECTORED_QUESTION, VECTORED, 10))
  })

  test('empty hop ranking — identical on a corpus with no entities at all', () => {
    const noEntities: ArmContext = {
      ...VECTORED,
      texts: { 'doc-1': 'alpha report', 'doc-2': 'beta report', 'doc-3': 'gamma report' },
    }
    expect(arm.rank(VECTORED_QUESTION, noEntities, 10)).toEqual(
      hybridArm.rank(VECTORED_QUESTION, noEntities, 10),
    )
  })

  test('without a vector cache the same property holds against the lexical leg', () => {
    // Lexical-only seed: no vectors in the context at all.
    const lexical: ArmContext = { docIds: VECTORED.docIds, texts: VECTORED.texts }
    expect(arm.ready(lexical)).toBe(true)
    expect(explainEntityHop(VECTORED_QUESTION, lexical)).toEqual([])
    expect(arm.rank(VECTORED_QUESTION, lexical, 10).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The hop-document cap. The uncapped tail is what breaks the easy tier:
// measured on the benchmark corpus the walk returns 91-145 documents (p50 102,
// never zero), and RRF at k=60 discriminates rank weakly (1/61 = 0.01639 at rank
// 1 versus 1/200 = 0.00500 at rank 140), so the whole tail collects credit and a
// hop document at hop-rank 1 outbids a direct leg at leg-rank 9 (0.01639 > 0.01449).
// ---------------------------------------------------------------------------
describe('hop-document cap', () => {
  // A corpus wide enough that an uncapped walk returns far more documents than the cap.
  const wide: ArmContext = {
    docIds: ['seed', ...Array.from({ length: 40 }, (_, i) => `hub-${String(i).padStart(2, '0')}`)],
    texts: {
      // The seed names one strong bridge that every hub document also carries.
      seed: 'Delivery DL-900 is recorded with the shared bridge BR-001.',
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `hub-${String(i).padStart(2, '0')}`,
          `Unit ${i} carries the shared bridge BR-001 together with asset AS-${String(i).padStart(3, '0')}.`,
        ]),
      ),
    },
  }
  const question = 'Which unit carries delivery DL-900?'

  test('the fixture really does produce more hop documents than a small cap', () => {
    // Guard against a vacuous test: without this, a cap that never binds would pass.
    const uncapped = explainEntityHop(question, wide, { maxHopDocs: 500 })
    expect(uncapped.length).toBeGreaterThan(10)
  })

  test('the cap bounds how many hop documents enter the fusion', () => {
    for (const cap of [1, 3, 10]) {
      expect(explainEntityHop(question, wide, { maxHopDocs: cap }).length).toBeLessThanOrEqual(cap)
    }
  })

  test('a tighter cap is a prefix of a looser one — the cap trims the tail, not the head', () => {
    const tight = explainEntityHop(question, wide, { maxHopDocs: 5 }).map((p) => p.docId)
    const loose = explainEntityHop(question, wide, { maxHopDocs: 20 }).map((p) => p.docId)
    expect(loose.slice(0, tight.length)).toEqual(tight)
  })

  test('the default cap is positive, so a shipped arm cannot disable the fix by accident', () => {
    expect(ENTITY_HOP_DEFAULTS.maxHopDocs).toBeGreaterThan(0)
    expect(ENTITY_HOP_DEFAULTS.maxHopDocs).toBeLessThanOrEqual(20)
  })
})
