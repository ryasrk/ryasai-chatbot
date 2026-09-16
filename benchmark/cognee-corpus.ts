/**
 * Cognee corpus generator — a synthetic enterprise world for benchmarking a
 * knowledge-graph memory layer, not a document store.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Two retrievers score 100% on a small, self-contained corpus without
 * retrieving anything useful:
 *
 *   1. "return everything" — with fewer documents than the context budget,
 *      stuffing the whole corpus is a valid strategy, so recall@k and
 *      answer-quality metrics measure the context window, not retrieval.
 *   2. keyword overlap — if the entity named in the question appears only in
 *      the document that answers it, BM25 alone matches the gold chunk and the
 *      graph layer is never exercised.
 *
 * So the generator is built backwards from those two failures. The corpus is
 * large enough that no retriever can return it all, every fact that answers a
 * multi-hop question is split across documents joined only by a shared entity
 * id, and the surface vocabulary of any relation is deliberately reused by
 * documents whose correct answer is a DIFFERENT entity (e.g. three vendors
 * deliver to Project Alpha, so mentioning Alpha and a vendor does not
 * identify which delivery the question asks about).
 *
 * Ground truth ships as typed relations next to the prose, because a question
 * generator that re-parses sentences re-derives whatever the prose says,
 * including the distractors — it would encode "INV-4471 was approved by Dwi"
 * as the answer to a question whose answer is "the vendor behind INV-4471".
 *
 * Two ABSENCE-shaped facts ship with the world because a corpus of positive
 * records cannot test update handling or rejection: 32 deliveries are reported
 * on time and then overturned by a correction memo (`index.corrections`), and
 * dedicated `negative_evidence` documents record that no incident was filed for
 * a given project+warehouse pair, so a question's right answer can be "no such
 * record" against a same-subject positive distractor.
 *
 * Usage:
 *   bun benchmark/cognee-corpus.ts --out=/tmp/corpus.json --docs=1200
 *   bun benchmark/cognee-corpus.ts --seed=99 --docs=300 --out=/tmp/small.json
 *   bun benchmark/cognee-corpus.ts --docs=12000 --with-uncertain --out=/tmp/big.json
 *
 *   --docs=N           total documents (default 900); N above HOT_DOCS grows only
 *                      the filler mass, so the entity pool and relation count are
 *                      stable across corpus sizes.
 *   --seed=N           PRNG seed (default 20240917).
 *   --out=FILE         write the corpus + ground-truth index as JSON.
 *   --no-corrections   omit the 32 supersession pairs.
 *   --with-uncertain   add the arithmetic layer (spelled-out quantities).
 *   --no-fillers       hot world only.
 *
 * Determinism: every value comes from the seeded PRNG below, including the
 * temporal clauses, so the same seed yields byte-identical JSON. Dates are
 * emitted as day offsets ("day 412") rather than wall-clock dates because
 * Date/Intl are locale- and timezone-dependent at output time.
 */

export type EntityType =
  | 'vendor'
  | 'person'
  | 'project'
  | 'warehouse'
  | 'invoice'
  | 'purchase_order'
  | 'batch'
  | 'serial'
  | 'audit_finding'
  | 'incident'
  | 'delivery'
  | 'approval'

/** Every `DocKind` except filler — filler carries no relations and is never budgeted. */
export type HotDocKind = Exclude<DocKind, 'filler'>

export type DocKind =
  | 'world_briefing'
  | 'vendor_master'
  | 'vendor_memo'
  | 'personnel_memo'
  | 'project_memo'
  | 'warehouse_memo'
  | 'purchase_order'
  | 'approval_memo'
  | 'invoice_memo'
  | 'delivery_note'
  | 'inventory_memo'
  | 'audit_finding'
  | 'incident_report'
  | 'correction_memo'
  | 'negative_evidence'
  | 'filler'

/**
 * A typed triple. `subject`/`object` are entity ids, except for the two
 * day-valued predicates (`arrived_day`, `was_late`, `reported_on_time`) whose
 * objects are `day-<n>` pseudo-ids.
 */
export interface GroundTruthRelation {
  subject: string
  predicate: string
  object: string
  /** Sentence-serialised form, so a consumer can grep the exact claim in `text`. */
  natural: string
  /** True when a later correction memo supersedes this triple (see `CorpusIndex.corrections`). */
  retracted?: boolean
  /**
   * Set on a triple that overturns an earlier one. Currently only `retracted`
   * is populated, on the superseded side; a consumer walking
   * `index.corrections` gets both sides explicitly, so this is not needed to
   * resolve a pair.
   */
  supersedes?: string
}

export interface CorpusDocument {
  id: string
  title: string
  kind: DocKind
  text: string
  /**
   * Ids of every entity this document asserts a triple about — NOT every name
   * its prose prints. Filler names entities without asserting anything, and
   * listing those would let a question generator build questions from entities
   * that have no ground truth behind them.
   */
  entityIds: string[]
  /** Free display names, index-aligned with `entityIds`. */
  entityNames: string[]
}

export interface CorpusIndex {
  seed: number
  /** Ids assigned by the world builder, so a question generator can hold a stable handle. */
  entityIds: {
    vendors: string[]
    people: string[]
    projects: string[]
    warehouses: string[]
    invoices: string[]
    purchaseOrders: string[]
    batches: string[]
    serials: string[]
    auditFindings: string[]
    incidents: string[]
    deliveries: string[]
    approvals: string[]
  }
  /** id → human name, for rendering question text without re-parsing prose. */
  namesById: Record<string, string>
  entitiesByType: Record<EntityType, string[]>
  /** Every document's mentions and triples, in document order. */
  documents: CorpusIndexEntry[]
  /** All triples over the HOT documents (the question-bearing half of the corpus). */
  relations: GroundTruthRelation[]
  /** Every inventory spelling an uncertain quantity. Off by default — see `CorpusOptions.includeUncertainQuantities`. */
  uncertainSpellings: UncertaintyGroundTruth[]
  /** Superseded triples paired with the triple that overturns them. */
  corrections: CorrectionGroundTruth[]
  /** Entities whose mention counts are so high that a high-recall retriever drags them in every time. */
  highFrequencyEntities: string[]
  stats: CorpusStats
}

export interface CorpusIndexEntry {
  id: string
  kind: DocKind
  entityIds: string[]
  relations: GroundTruthRelation[]
}

export interface UncertaintyGroundTruth {
  invoiceId: string
  serialId: string
  uncertainDocId: string
  /** The doc that states the resolved amount — not reachable by matching the uncertain sentence's digits. */
  resolvingDocId: string
  serialValue: number
  invoiceTotal: number
  /** The arithmetic the question ultimately requires. */
  sum: number
}

export interface CorrectionGroundTruth {
  deliveryId: string
  subject: string
  predicate: string
  incorrectDocId: string
  /** What the first memo claimed; wrong unless the correction is surfaced. */
  incorrectAssertion: string
  correctDocId: string
  correctAssertion: string
  /** The project the delivery ultimately reached — unaffected by the timing correction, so it survives a stale read. */
  projectId: string
  vendorId: string
}

export interface CorpusStats {
  docs: number
  hotDocs: number
  fillerDocs: number
  chars: number
  sentences: number
  relationCount: number
  distinctEntities: number
}

export interface CorpusOptions {
  seed?: number
  /** Total document count, hot world plus filler. */
  totalDocs?: number
  /**
   * Fillers reference the same vendors/warehouses/projects as the answer-bearing
   * documents but assert nothing typeable about them. They raise the collision
   * rate deliberately: a multi-keyword query ("vendor Sinar Abadi project
   * Gamma") matches them without matching any ground-truth triple.
   */
  includeFillers?: boolean
  /**
   * The supersession layer: 32 deliveries first reported on time and later
   * overturned by a correction memo, paired in `CorpusIndex.corrections`.
   *
   * ON by default because a benchmark that cannot ask "which record is current"
   * cannot distinguish a retriever that updates from one that returns the first
   * match. Turning it off is for callers that want the smaller, single-record
   * corpus.
   */
  includeCorrections?: boolean
  /**
   * Adds the uncertain-quantity layer: inventory memos whose text spells
   * "one thousand two hundred" where the ground truth is 1,200, so a numeric
   * question cannot be answered from the digits the memo prints. Off by default
   * because it roughly doubles the invoice/serial doc count and is only needed
   * by questions that require an arithmetic step.
   */
  includeUncertainQuantities?: boolean
  /** Skip the index build for callers that only want raw text (not exposed on the CLI). */
  includeIndex?: boolean
}

export interface Corpus {
  docs: CorpusDocument[]
  index?: CorpusIndex
}

export interface CorpusWorld {
  vendors: Entity[]
  people: Entity[]
  projects: Entity[]
  warehouses: Entity[]
  invoices: Entity[]
  purchaseOrders: Entity[]
  batches: Entity[]
  serials: Entity[]
  auditFindings: Entity[]
  incidents: Entity[]
  deliveries: Entity[]
  approvals: Entity[]
}

export interface Entity {
  id: string
  name: string
  type: EntityType
}

// Fixed-size world. None of these scale with --docs: the document generator
// allocates facts across a bounded entity pool, so --docs=300 is a thinner
// corpus over the SAME world rather than a different one.
const VENDOR_COUNT = 40
const PERSON_COUNT = 80
const PROJECT_COUNT = 30
const WAREHOUSE_COUNT = 15
const AUDIT_FINDING_COUNT = 60
const INCIDENT_COUNT = 32
const INVOICE_COUNT = 220
const DELIVERY_COUNT = 120
const ORDER_COUNT = 60

/**
 * Invoice/serial pairs in the optional uncertainty layer. Each pair is two
 * documents, so the hot budget must reserve `UNCERTAINTY_PAIRS * 2`.
 */
const UNCERTAINTY_PAIRS = 34

/**
 * Documents one audit-finding unit realizes. The kind emits a finding narrative
 * AND a separate vendor-attribution note, because a single document asserting
 * both the vendor and the project collapses every "which project for the vendor"
 * question into a substring match.
 */
const DOCS_PER_AUDIT_UNIT = 2

/** Kinds that realize exactly one document, used to spend the post-unit remainder. */
const SINGLE_DOC_KINDS: HotDocKind[] = [
  'warehouse_memo',
  'personnel_memo',
  'invoice_memo',
  'project_memo',
  'inventory_memo',
  'vendor_memo',
]

/**
 * Ceiling on the hot (relation-bearing) world. Filler is appended after it, so
 * `--docs` above this grows only the question-neutral mass — the entity pool and
 * the relation count stay fixed, which is what makes a question set built at
 * `--docs=12000` still valid at `--docs=2000`.
 *
 * Below this count the hot world is proportionally thinned and whole sections
 * lose documents, so a question built from a dropped relation would be
 * unanswerable and read as a retrieval miss. Callers must treat a shortfall
 * here as fatal rather than as a smaller benchmark.
 */
export const HOT_DOCS = 900

/**
 * Per-kind share of the hot world, in WEIGHTS not documents. Weights exist so
 * `--docs` can be honoured exactly at any value: quotas are apportioned by
 * weight and the largest-remainder pass makes the totals sum to the budget, so
 * `docs.length === --docs` instead of "roughly --docs".
 *
 * Warehouse memos carry the most weight because the serial sweep is the
 * expensive step in them: a question has to walk every memo listing a given
 * batch before the missing serial turns up.
 */
const HOT_KIND_WEIGHTS: Record<HotDocKind, number> = {
  world_briefing: 14,
  vendor_master: 45,
  vendor_memo: 80,
  personnel_memo: 80,
  project_memo: 60,
  warehouse_memo: 120,
  purchase_order: 60,
  approval_memo: 60,
  invoice_memo: 42,
  delivery_note: 42,
  inventory_memo: 57,
  audit_finding: 90,
  incident_report: 32,
  correction_memo: 34,
  // The complex tier's negative-evidence sub-mechanism has no other source: the
  // corpus needs documents that positively record the ABSENCE of a fact, so a
  // question can require the retriever to reject a plausible positive distractor.
  negative_evidence: 60,
}

// Role rotations are reversed against each other, so a person's role and their
// function-in-the-approval-chain never correlate — every role shows up in both
// the approver and the auditor sentences, which is what makes a role keyword
// useless for narrowing the candidate set.
const ROLES = [
  'procurement lead',
  'finance manager',
  'operations supervisor',
  'auditor',
  'warehouse inspector',
] as const

const SITES = [
  'Jakarta DC',
  'Surabaya DC',
  'Bandung DC',
  'Medan Hub',
  'Semarang Hub',
  'Makassar Depot',
  'Balikpapan Depot',
  'Cikarang Plant',
  'Batam Yard',
] as const

/** Warehouse index → site, so a row appears in one memo instead of three. */
const WAREHOUSE_SITE_BY_INDEX = [
  'Medan Hub',
  'Cikarang Plant',
  'Semarang Hub',
  'Makassar Depot',
  'Surabaya DC',
  'Jakarta DC',
  'Bandung DC',
  'Batam Yard',
  'Jakarta DC',
  'Surabaya DC',
  'Balikpapan Depot',
  'Medan Hub',
  'Semarang Hub',
  'Bandung DC',
  'Cikarang Plant',
] as const

const CARRIERS = [
  { carrier: 'Andalan Logistik', truck: 'truck-14' },
  { carrier: 'Mitra Kargo', truck: 'truck-07' },
  { carrier: 'Trans Nusantara', truck: 'truck-22' },
  { carrier: 'Pelni Cargo', truck: 'truck-03' },
  { carrier: 'Sumber Kirim', truck: 'truck-31' },
] as const

const FILLER_SUBJECTS = [
  'canteen restock',
  'staff shuttle route',
  'office cleaning contract',
  'parking allocation',
  'uniform fitting schedule',
  'safety shoe sizing',
  'travel desk quota',
  'cafeteria menu review',
  'fire drill logistics',
  'office move to floor nine',
] as const

const FILLER_SETTINGS = [
  'the Jakarta head office',
  'the Surabaya branch',
  'the Bandung training room',
  'the Medan guest house',
  'the Cikarang plant canteen',
] as const

// Tier prefixes are distinct so that every prefix of any company name resolves
// to exactly one vendor: a retriever that matches on "PT Bumi" must not be able
// to count two candidates for a question about "PT Bumi Sentosa".
const VENDOR_TIERS = [
  'Sinar',
  'Bumi',
  'Anugerah',
  'Cahaya',
  'Mega',
  'Karya',
  'Tunas',
  'Prima',
  'Sentra',
  'Fajar',
  'Hasil',
  'Mulia',
  'Nusa',
  'Panca',
  'Ridho',
  'Sakti',
  'Tirta',
  'Wahana',
] as const

const VENDOR_SUFFIXES = [
  'Abadi',
  'Sentosa',
  'Sejahtera',
  'Lestari',
  'Perkasa',
  'Makmur',
] as const

const PERSON_GIVEN = [
  'Adi',
  'Budi',
  'Citra',
  'Dewi',
  'Eko',
  'Fitri',
  'Gunawan',
  'Hesti',
  'Indra',
  'Joko',
] as const

const PERSON_FAMILY = [
  'Nugroho',
  'Wijaya',
  'Pratama',
  'Halim',
  'Santoso',
  'Maulana',
  'Susanto',
  'Hartanto',
] as const

const THOUSANDS = [
  'one thousand',
  'two thousand',
  'three thousand',
  'four thousand',
  'five thousand',
  'six thousand',
] as const

const HUNDREDS = [
  'one hundred',
  'two hundred',
  'three hundred',
  'four hundred',
  'five hundred',
  'six hundred',
  'seven hundred',
  'eight hundred',
  'nine hundred',
] as const

const UNITS = [
  'eleven',
  'twelve',
  'thirteen',
  'fifteen',
  'eighteen',
  'twenty one',
  'twenty four',
  'thirty six',
  'forty two',
  'fifty five',
  'sixty four',
  'seventy five',
] as const

/**
 * mulberry32. Chosen over a shuffle-based LCG because the generator draws from
 * overlapping index ranges (a batch index must stay inside the batch table); a
 * generator whose low bits are weak would concentrate early draws and quietly
 * make most documents cite the same dozen entities.
 */
function createRng(seed: number): () => number {
  let a = (seed | 0) + 0x6d2b79f5
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

function id(prefix: string, ordinal: number, width: number): string {
  return `${prefix}-${pad(ordinal, width)}`
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length]
}

function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

/** `intro` + `middle` + `tail` = 3 sentences, which is the floor in the brief. */
function sentences(intro: string, middle: string, tail: string): string {
  return [intro, middle, tail].join(' ')
}

// ---------------------------------------------------------------------------
// World tables
// ---------------------------------------------------------------------------

function buildVendors(): Entity[] {
  const out: Entity[] = []
  for (let i = 0; i < VENDOR_COUNT; i++) {
    const tier = VENDOR_TIERS[Math.floor(i / VENDOR_SUFFIXES.length)]
    const suffix = VENDOR_SUFFIXES[i % VENDOR_SUFFIXES.length]
    out.push({ id: id('ven', i + 1, 2), name: `PT ${tier} ${suffix}`, type: 'vendor' })
  }
  return out
}

function buildPeople(): Entity[] {
  const out: Entity[] = []
  for (let i = 0; i < PERSON_COUNT; i++) {
    const given = PERSON_GIVEN[Math.floor(i / PERSON_FAMILY.length)]
    const family = PERSON_FAMILY[i % PERSON_FAMILY.length]
    out.push({ id: id('per', i + 1, 3), name: `${given} ${family}`, type: 'person' })
  }
  return out
}

/**
 * Alpha..Sierra, then numbered projects. The Greek names carry no relation to
 * project size or site, so a question that names one project is not answerable
 * from the naming convention alone.
 */
function buildProjects(): Entity[] {
  const greek = [
    'Alpha',
    'Beta',
    'Gamma',
    'Delta',
    'Epsilon',
    'Zeta',
    'Eta',
    'Theta',
    'Iota',
    'Kappa',
    'Lambda',
    'Mu',
    'Nu',
    'Xi',
    'Omicron',
    'Pi',
    'Rho',
    'Sigma',
    'Tau',
    'Upsilon',
    'Phi',
    'Chi',
    'Psi',
    'Omega',
    'Sierra',
  ]
  const out: Entity[] = []
  greek.forEach((name, i) => {
    out.push({ id: id('proj', i + 1, 2), name: `Project ${name}`, type: 'project' })
  })
  for (let i = greek.length; i < PROJECT_COUNT; i++) {
    out.push({ id: id('proj', i + 1, 2), name: `Project ${pad(i - greek.length + 1, 2)}`, type: 'project' })
  }
  return out
}

function buildWarehouses(): Entity[] {
  const out: Entity[] = []
  for (let i = 0; i < WAREHOUSE_COUNT; i++) {
    out.push({ id: id('wh', i + 1, 2), name: `W-${pad(i + 1, 2)}`, type: 'warehouse' })
  }
  return out
}

function buildSimple(prefix: string, count: number, width: number, type: EntityType): Entity[] {
  const out: Entity[] = []
  for (let i = 0; i < count; i++) {
    out.push({ id: id(prefix, i + 1, width), name: id(prefix.toUpperCase(), i + 1, width), type })
  }
  return out
}

function buildWorld(): CorpusWorld {
  const auditFindings: Entity[] = []
  for (let i = 0; i < AUDIT_FINDING_COUNT; i++) {
    auditFindings.push({
      id: id('af', i + 1, 3),
      name: `Finding AF-${pad(i + 1, 3)}`,
      type: 'audit_finding',
    })
  }
  const incidents: Entity[] = []
  for (let i = 0; i < INCIDENT_COUNT; i++) {
    incidents.push({ id: id('inc', i + 1, 3), name: `incident IR-${pad(i + 1, 3)}`, type: 'incident' })
  }
  const deliveries: Entity[] = []
  for (let i = 0; i < DELIVERY_COUNT; i++) {
    deliveries.push({ id: id('dlv', i + 1, 3), name: `delivery DL-${pad(i + 1, 3)}`, type: 'delivery' })
  }
  const approvals: Entity[] = []
  for (let i = 0; i < ORDER_COUNT; i++) {
    approvals.push({ id: id('apr', i + 1, 3), name: `approval AR-${pad(i + 1, 3)}`, type: 'approval' })
  }
  return {
    vendors: buildVendors(),
    people: buildPeople(),
    projects: buildProjects(),
    warehouses: buildWarehouses(),
    invoices: buildSimple('inv', INVOICE_COUNT, 4, 'invoice'),
    purchaseOrders: buildSimple('po', ORDER_COUNT, 4, 'purchase_order'),
    batches: buildSimple('b', 300, 4, 'batch'),
    serials: buildSimple('sn', 900, 4, 'serial'),
    auditFindings,
    incidents,
    deliveries,
    approvals,
  }
}

function _worldEntityCount(world: CorpusWorld): number {
  return (
    world.vendors.length +
    world.people.length +
    world.projects.length +
    world.warehouses.length +
    world.invoices.length +
    world.purchaseOrders.length +
    world.batches.length +
    world.serials.length +
    world.auditFindings.length +
    world.incidents.length +
    world.deliveries.length +
    world.approvals.length
  )
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

interface MutableDoc {
  kind: DocKind
  title: string
  text: string
  relations: GroundTruthRelation[]
}

/** Spells 1112 as "one thousand one hundred twelve" — digit-free on purpose. */
function spellNumber(value: number): string {
  const thousands = Math.floor(value / 1000)
  const remainder = value % 1000
  const hundreds = Math.floor(remainder / 100)
  const unitsMatch = [11, 12, 13, 15, 18, 21, 24, 36, 42, 55, 64, 75].indexOf(remainder % 100)
  const unitWord = unitsMatch >= 0 ? UNITS[unitsMatch] : 'ten'
  const parts = [`${THOUSANDS[thousands]} ${HUNDREDS[hundreds]}`, unitWord]
  return parts.join(' ')
}

class CorpusBuilder {
  private rng: () => number
  private world: CorpusWorld
  private docs: MutableDoc[] = []
  private namesById: Record<string, string> = {}
  private uncertainSpellings: UncertaintyGroundTruth[] = []
  private corrections: CorrectionGroundTruth[] = []
  private includeCorrections = true

  constructor(seed: number) {
    this.rng = createRng(seed)
    this.world = buildWorld()
    this.buildNames()
  }

  private buildNames(): void {
    const all: Entity[] = [
      ...this.world.vendors,
      ...this.world.people,
      ...this.world.projects,
      ...this.world.warehouses,
      ...this.world.invoices,
      ...this.world.purchaseOrders,
      ...this.world.batches,
      ...this.world.serials,
      ...this.world.auditFindings,
      ...this.world.incidents,
      ...this.world.deliveries,
      ...this.world.approvals,
    ]
    for (const ent of all) this.namesById[ent.id] = ent.name
  }

  private nameOf(entityId: string): string {
    const name = this.namesById[entityId]
    if (!name) throw new Error(`unknown entity ${entityId}`)
    return name
  }

  private at(entities: Entity[], index: number): Entity {
    return entities[((index % entities.length) + entities.length) % entities.length]
  }

  /**
   * Covers `entities` exactly once every `entities.length` ordinals, then
   * advances by a stride. A plain `entities[ordinal % n]` collapses whenever a
   * kind has more documents than the table has rows: 120 warehouse memos over
   * 15 warehouses means 8 memos share one warehouse AND `ordinal * k` wraps
   * onto the same vendor several times, so a "vendor" relation ends up with 23
   * distinct subjects instead of 120. `stride` must be coprime with the table
   * size (`assertCoprime` checks it) so the first `n` ordinals are injective.
   */
  private spread(entities: Entity[], ordinal: number, stride: number): Entity {
    const n = entities.length
    const bucket = Math.floor(ordinal / n)
    const offset = ordinal % n
    return entities[((offset + bucket * stride) % n + n) % n]
  }

  /** Returns the id the document WILL get, because ground-truth examples must cite ids, not positions. */
  private push(kind: DocKind, title: string, text: string, relations: GroundTruthRelation[] = []): string {
    this.docs.push({ kind, title, text, relations })
    return id('doc', this.docs.length, 4)
  }

  private rel(subject: string, predicate: string, object: string, natural: string, extra?: Partial<GroundTruthRelation>): GroundTruthRelation {
    return { subject, predicate, object, natural, ...extra }
  }

  /**
   * `--docs` controls the total, filler included. The hot world is apportioned
   * by weight so every kind survives at any size: a plan that instead generated
   * the full world and truncated it would drop whole sections at small sizes,
   * and dropping the approval memos would leave the invoice memos pointing at
   * approvals that no longer exist.
   */
  generate(options: {
    totalDocs: number
    includeFillers: boolean
    includeCorrections: boolean
    includeUncertainQuantities: boolean
  }): MutableDoc[] {
    // Hot kinds are planned against a budget that reserves room for the optional
    // layers. Planning to the full HOT_DOCS cap and then appending the layers
    // pushed the hot count to 1061 — a corpus advertising "at most 900
    // relation-bearing documents" whose relation count then varied with an
    // unrelated flag.
    this.includeCorrections = options.includeCorrections
    const reserve = options.includeUncertainQuantities ? this.uncertaintyLayerSize() : 0
    this.generateHot(options.totalDocs - reserve)
    if (options.includeUncertainQuantities) this.appendUncertaintyLayer()
    if (options.includeFillers && this.docs.length < options.totalDocs) this.appendFillers(options.totalDocs)
    return this.docs
  }

  /** Documents the optional uncertainty layer will append, counted before generating it. */
  private uncertaintyLayerSize(): number {
    return UNCERTAINTY_PAIRS * 2
  }

  private generateHot(totalDocs: number): void {
    const budget = Math.min(HOT_DOCS, Math.max(0, totalDocs))
    const plan = this.buildPlan(budget)
    for (const kind of plan) this.emit(kind)
    // Halving the audit quota can leave one unit's worth of documents unplaced
    // (an odd audit quota floors). Single-document kinds absorb the slack so the
    // realized count equals the request instead of landing on budget-1.
    let extra = 0
    while (this.docs.length < budget) {
      this.emit(SINGLE_DOC_KINDS[extra % SINGLE_DOC_KINDS.length])
      extra += 1
    }
  }

  /**
   * Per-kind document quotas for the hot world, summing EXACTLY to `budget`.
   *
   * Apportioned by weight with a largest-remainder pass, because plain rounding
   * drifts: quotas would sum to 1197 for a 1200-document request and the corpus
   * would silently be three documents short of what a benchmark's "corpus size"
   * axis claims to vary.
   */
  private buildQuotas(budget: number): Map<HotDocKind, number> {
    const kinds = Object.keys(HOT_KIND_WEIGHTS) as HotDocKind[]
    const totalWeight = kinds.reduce((sum, k) => sum + HOT_KIND_WEIGHTS[k], 0)
    const quotas = new Map<HotDocKind, number>()
    const remainders: { kind: HotDocKind; remainder: number }[] = []
    let assigned = 0
    for (const kind of kinds) {
      const exact = (HOT_KIND_WEIGHTS[kind] / totalWeight) * budget
      const floor = Math.floor(exact)
      quotas.set(kind, floor)
      remainders.push({ kind, remainder: exact - floor })
      assigned += floor
    }
    // Ties broken by weight then by kind name, never by insertion order, so the
    // allocation is a pure function of `budget`.
    remainders.sort((a, b) =>
      a.remainder === b.remainder
        ? HOT_KIND_WEIGHTS[b.kind] - HOT_KIND_WEIGHTS[a.kind] || (a.kind < b.kind ? -1 : 1)
        : b.remainder - a.remainder,
    )
    for (let i = 0; i < remainders.length && assigned < budget; i++) {
      quotas.set(remainders[i].kind, (quotas.get(remainders[i].kind) ?? 0) + 1)
      assigned += 1
    }
    return quotas
  }

  /**
   * Plan the hot world in DOCUMENTS, then convert to units.
   *
   * An audit finding is the one kind whose unit emits two documents (narrative
   * plus a separate vendor-attribution note), so its document quota is halved.
   * Budgeting in units against an average factor instead overshot — 922 realized
   * documents for a 900 request — because the remainder loop can only add.
   *
   * The plan is walked round-robin over kinds so document ids are not grouped:
   * doc-0401..doc-0442 all being invoices would let a retriever route on the id
   * prefix without reading a word of the text.
   */
  private buildPlan(budget: number): HotDocKind[] {
    const quotas = this.buildQuotas(budget)
    const perKind = new Map<HotDocKind, number>()
    for (const kind of [...quotas.keys()]) {
      const docsForKind = quotas.get(kind) ?? 0
      perKind.set(kind, kind === 'audit_finding' ? Math.floor(docsForKind / DOCS_PER_AUDIT_UNIT) : docsForKind)
    }
    const out: HotDocKind[] = []
    while (out.length < budget) {
      let placed = false
      for (const kind of perKind.keys()) {
        const remaining = perKind.get(kind) ?? 0
        if (remaining > 0) {
          out.push(kind)
          perKind.set(kind, remaining - 1)
          placed = true
          if (out.length >= budget) break
        }
      }
      if (!placed) break
    }
    return out
  }

  private emit(kind: DocKind): void {
    switch (kind) {
      case 'world_briefing':
        this.emitWorldBriefing(this.docs.filter((d) => d.kind === 'world_briefing').length)
        break
      case 'vendor_master':
        this.emitVendorMaster(this.docs.filter((d) => d.kind === 'vendor_master').length)
        break
      case 'vendor_memo':
        this.emitVendorMemo(this.docs.filter((d) => d.kind === 'vendor_memo').length)
        break
      case 'personnel_memo':
        this.emitPersonnelMemo(this.docs.filter((d) => d.kind === 'personnel_memo').length)
        break
      case 'project_memo':
        this.emitProjectMemo(this.docs.filter((d) => d.kind === 'project_memo').length)
        break
      case 'warehouse_memo':
        this.emitWarehouseMemo(this.docs.filter((d) => d.kind === 'warehouse_memo').length)
        break
      case 'purchase_order':
        this.emitPurchaseOrder(this.docs.filter((d) => d.kind === 'purchase_order').length)
        break
      case 'approval_memo':
        this.emitApprovalMemo(this.docs.filter((d) => d.kind === 'approval_memo').length)
        break
      case 'invoice_memo':
        this.emitInvoiceMemo(this.docs.filter((d) => d.kind === 'invoice_memo').length)
        break
      case 'delivery_note':
        this.emitDeliveryNote(this.docs.filter((d) => d.kind === 'delivery_note').length)
        break
      case 'inventory_memo':
        this.emitInventoryMemo(this.docs.filter((d) => d.kind === 'inventory_memo').length)
        break
      case 'audit_finding':
        this.emitAuditFinding(this.docs.filter((d) => d.kind === 'audit_finding').length)
        this.emitVendorAttribution(this.docs.filter((d) => d.kind === 'audit_finding').length)
        break
      case 'incident_report':
        this.emitIncidentReport(this.docs.filter((d) => d.kind === 'incident_report').length)
        break
      case 'correction_memo':
        if (!this.includeCorrections) break
        this.emitCorrectionMemo(this.docs.filter((d) => d.kind === 'correction_memo').length)
        break
      case 'negative_evidence':
        this.emitNegativeEvidence(this.docs.filter((d) => d.kind === 'negative_evidence').length)
        break
      case 'filler':
        break
    }
  }

  private day(min: number, max: number): number {
    return intBetween(this.rng, min, max)
  }

  private emitWorldBriefing(ordinal: number): void {
    const vendor = this.spread(this.world.vendors, ordinal, 11)
    const site = SITES[ordinal % SITES.length]
    const site2 = SITES[(ordinal + 4) % SITES.length]
    const project = this.spread(this.world.projects, ordinal, 7)
    const project2 = this.spread(this.world.projects, ordinal + 11, 7)
    const text = sentences(
      `Quarterly operations briefing cycle ${ordinal + 1} covering ${site} and ${site2}; this cycle sampled ${vendor.name} orders against ${project.name} and ${project2.name} scope.`,
      `Volumes are stated at site level and are not attributable to a single vendor, so any per-vendor figure in this briefing is a site aggregate.`,
      `Nothing in this briefing supersedes an approved purchase order or a posted delivery note.`,
    )
    this.push('world_briefing', `Operations briefing cycle ${ordinal + 1}`, text)
  }

  private emitVendorMaster(ordinal: number): void {
    const vendor = this.spread(this.world.vendors, ordinal, 11)
    const site = SITES[ordinal % SITES.length]
    const secondary = SITES[(ordinal + 6) % SITES.length]
    const text = sentences(
      `Vendor master record for ${vendor.name} lists ${site} as its primary delivery site and ${secondary} as a secondary site.`,
      `The record covers spare-part fabrication and calibration support, and both sites are approved for those two categories only.`,
      `Site scope is reviewed annually and a site listed here does not imply an active order.`,
    )
    this.push('vendor_master', `Vendor master record ${vendor.name}`, text)
  }

  private emitVendorMemo(ordinal: number): void {
    const vendor = this.spread(this.world.vendors, ordinal, 11)
    const lead = this.spread(this.world.people, ordinal, 13)
    const otherLead = this.spread(this.world.people, ordinal + 3, 13)
    const invoice = this.spread(this.world.invoices, ordinal, 17)
    const warehouse = this.spread(this.world.warehouses, ordinal, 7)
    const text = sentences(
      `Category review for ${vendor.name}, chaired by ${lead.name} with ${otherLead.name} attending for the second half.`,
      `The vendor is tied to ${invoice.name} for the sample this quarter, and lot servicing happens at ${warehouse.name}.`,
      `This memo broadens the vendor's sourcing scope but does not place, amend, or approve an order.`,
    )
    this.push('vendor_memo', `Category review ${vendor.name}`, text)
  }

  private emitPersonnelMemo(ordinal: number): void {
    const person = this.spread(this.world.people, ordinal, 13)
    const role = ROLES[(ordinal + 1) % ROLES.length]
    const otherPerson = this.spread(this.world.people, ordinal + 5, 13)
    const otherRole = ROLES[(ordinal + 3) % ROLES.length]
    const warehouse = this.spread(this.world.warehouses, ordinal, 7)
    const text = sentences(
      `${person.name} (employee EMP-${pad(ordinal + 1, 3)}) has covered the ${role} desk since day ${this.day(120, 400)}, working out of the ${warehouse.name} support pod.`,
      `${otherPerson.name} holds the ${otherRole} delegation and signs only when the primary delegate is off-site, so an approval line naming this person is usually a cover signature.`,
      `Cover arrangements in this memo do not transfer approval authority for orders above the standing delegation limit.`,
    )
    this.push('personnel_memo', `Personnel note ${person.name}`, text)
  }

  private emitProjectMemo(ordinal: number): void {
    const project = this.spread(this.world.projects, ordinal, 7)
    const otherProject = this.spread(this.world.projects, ordinal + 7, 7)
    const site = SITES[ordinal % SITES.length]
    const supervisor = this.spread(this.world.people, ordinal + 17, 13)
    const text = sentences(
      `${project.name} enters phase ${(ordinal % 4) + 1} at ${site}, with ${supervisor.name} named operations supervisor for the phase.`,
      `Shared site services with ${otherProject.name} are billed at site level; this memo carries no per-project figure.`,
      `Phase boundaries here are planning markers and do not commit any spend.`,
    )
    this.push('project_memo', `Project memo ${project.name}`, text)
  }

  private emitPurchaseOrder(ordinal: number): void {
    const order = this.spread(this.world.purchaseOrders, ordinal, 7)
    const vendor = this.spread(this.world.vendors, ordinal, 11)
    const site = SITES[ordinal % SITES.length]
    const text = sentences(
      `${order.name} was raised against ${vendor.name} for spare-part fabrication at ${site}.`,
      `The order carries a three-line scope and the split across cost centres is recorded only in the line-item appendix kept by the receiving site.`,
      `This memo states the vendor; it does not state which project the goods were ultimately booked to.`,
    )
    const relations = [this.rel(order.id, 'raised_against', vendor.id, `raising purchase order ${order.name} against vendor ${vendor.name}`)]
    this.push('purchase_order', `Purchase order ${order.name}`, text, relations)
  }

  private emitApprovalMemo(ordinal: number): void {
    const approval = this.spread(this.world.approvals, ordinal, 7)
    const person = this.spread(this.world.people, ordinal, 13)
    const role = ROLES[(ordinal + 2) % ROLES.length]
    const order = this.spread(this.world.purchaseOrders, ordinal, 7)
    const site = SITES[ordinal % SITES.length]
    const text = sentences(
      `${person.name}, ${role}, signed ${approval.name} covering ${order.name} at ${site}.`,
      `The signature line records the delegate's desk title only, and two approvals were signed on the same day by two holders of the same title.`,
      `An approval signature here names the signer; the order's line items remain in the site appendix.`,
    )
    // Same person and same role appear on many approval memos: the role is a
    // distractor key, the person is the discriminating one.
    const relations = [
      this.rel(person.id, 'signed_off', approval.id, `${person.name} signed off approval ${approval.name}`),
      this.rel(approval.id, 'covers', order.id, `approval ${approval.name} covers purchase order ${order.name}`),
    ]
    this.push('approval_memo', `Approval memo ${approval.name}`, text, relations)
  }

  private emitInvoiceMemo(ordinal: number): void {
    const invoice = this.spread(this.world.invoices, ordinal, 17)
    const person = this.spread(this.world.people, ordinal, 13)
    const amount = 40_000_000 + intBetween(this.rng, 0, 3600) * 10_000
    const _site = SITES[ordinal % SITES.length]
    const text = sentences(
      `Invoice ${invoice.name} for ${amount.toLocaleString('en-US')} IDR was approved by ${person.name} on day ${this.day(200, 620)}.`,
      `The approval packet records the approver's name and the gross figure; it does not record the vendor or the order behind the invoice.`,
      `${person.name} approved a second invoice the same week, so the approver's name alone is not unique to this invoice.`,
    )
    // `approved` is split from `from_vendor`/`against_order` on purpose: the
    // vendor behind an invoice is never on the approval memo, so answering
    // "who approved the invoice from vendor X" needs both documents.
    const relations = [this.rel(person.id, 'approved', invoice.id, `${person.name} approved invoice ${invoice.name}`)]
    this.push('invoice_memo', `Invoice approval ${invoice.name}`, text, relations)
  }

  /**
   * The vendor is deliberately ABSENT here even though the real memo would name
   * it. With vendor and project in one sentence, "which project did vendor V's
   * delivery reach" is answered by a single document — the join the benchmark
   * is supposed to exercise collapsed into a substring match. The vendor half
   * lives on the dock intake memo instead (see `emitWarehouseMemo`).
   */
  private emitDeliveryNote(ordinal: number): void {
    const delivery = this.spread(this.world.deliveries, ordinal, 7)
    const project = this.spread(this.world.projects, ordinal, 7)
    const batch = this.spread(this.world.batches, ordinal, 13)
    const warehouse = this.spread(this.world.warehouses, ordinal, 7)
    const day = this.day(240, 560)
    const text = sentences(
      `${delivery.name} was reported on time on day ${day}, arriving at ${warehouse.name} under batch ${batch.name}.`,
      `The delivery note routes the batch to ${project.name} for phase installation and lists no equipment serial.`,
      `The inbound vendor is recorded on the dock intake memo for this warehouse, not on the delivery note itself.`,
    )
    // Three deliveries per vendor and three per project, so ("vendor X delivered
    // to project Y") has several near-miss siblings differing only in the other
    // hop — the reason a question must traverse, not match.
    const relations = [
      this.rel(delivery.id, 'for_project', project.id, `delivery ${delivery.name} supplied project ${project.name}`),
      this.rel(delivery.id, 'carried_batch', batch.id, `delivery ${delivery.name} carried batch ${batch.name}`),
      this.rel(delivery.id, 'reported_on_time', `day-${day}`, `delivery ${delivery.name} was reported on time on day ${day}`),
    ]
    this.push('delivery_note', `Delivery note ${delivery.name}`, text, relations)
  }

  private emitInventoryMemo(ordinal: number): void {
    const batch = this.spread(this.world.batches, ordinal, 13)
    const warehouse = this.spread(this.world.warehouses, ordinal, 7)
    const serialCount = 2 + (ordinal % 3)
    const serialStart = (ordinal * 11) % (this.world.serials.length - serialCount - 1)
    const serials: Entity[] = []
    for (let k = 0; k < serialCount; k++) serials.push(this.at(this.world.serials, serialStart + k))
    const inspector = this.spread(this.world.people, ordinal + 29, 13)
    const names = serials.map((s) => s.name).join(', ')
    const text = sentences(
      `Warehouse stock check at ${warehouse.name} logged ${serials.length} serialised units from batch ${batch.name}: ${names}.`,
      `${inspector.name} inspected the lot and did not count a spare unit, so only the units listed above belong to this batch at this site.`,
      `A unit logged at two sites is a bookkeeping duplicate and is removed rather than recounted.`,
    )
    const relations: GroundTruthRelation[] = []
    for (const serial of serials) {
      relations.push(this.rel(batch.id, 'contains_serial', serial.id, `batch ${batch.name} contains serial ${serial.name}`))
    }
    this.push('inventory_memo', `Stock check batch ${batch.name}`, text, relations)
  }

  private emitWarehouseMemo(ordinal: number): void {
    const warehouse = this.spread(this.world.warehouses, ordinal, 7)
    const site = WAREHOUSE_SITE_BY_INDEX[ordinal % WAREHOUSE_SITE_BY_INDEX.length]
    const delivery = this.spread(this.world.deliveries, ordinal, 7)
    const vendor = this.spread(this.world.vendors, ordinal, 11)
    const inspectionDay = this.day(260, 580)
    const text = sentences(
      `Dock intake summary for ${warehouse.name} at ${site}: ${delivery.name} arrived on day ${inspectionDay} from inbound vendor ${vendor.name}.`,
      `The dock log records the arrival day as read off the gate scanner, and the same gate timestamp was reused for a second receipt on the same shift.`,
      `The receiving project is not recorded at the dock; it is fixed on the delivery note for ${delivery.name}, and batch contents are answered from the stock-check memos.`,
    )
    const relations = [
      this.rel(delivery.id, 'from_vendor', vendor.id, `delivery ${delivery.name} came from vendor ${vendor.name}`),
      this.rel(warehouse.id, 'received_delivery', delivery.id, `${warehouse.name} received delivery ${delivery.name}`),
      this.rel(delivery.id, 'arrived_day', `day-${inspectionDay}`, `delivery ${delivery.name} arrived on day ${inspectionDay}`),
    ]
    this.push('warehouse_memo', `Dock intake ${warehouse.name}`, text, relations)
  }

  /**
   * The finding is split across the narrative and the sampling annex. An early
   * draft stated the vendor and the project in one sentence, which made every
   * "which project does the finding naming vendor V sit under" question
   * single-document — the graph layer was never needed to answer it, so the
   * benchmark measured sentence matching.
   */
  private emitAuditFinding(ordinal: number): void {
    const finding = this.spread(this.world.auditFindings, ordinal, 7)
    const auditor = this.spread(this.world.people, ordinal, 13)
    const project = this.spread(this.world.projects, ordinal, 7)
    const warehouse = this.spread(this.world.warehouses, ordinal, 7)
    const text = sentences(
      `${finding.name} was raised by ${auditor.name} against receiving controls at ${warehouse.name}, and the sampling annex ties the finding to ${project.name}.`,
      `The narrative section of the finding does not name the vendor in scope; that attribution is recorded in a separate vendor-attribution note.`,
      `Findings are observational; they do not by themselves change the timing recorded on the delivery note.`,
    )
    const relations = [
      this.rel(auditor.id, 'raised', finding.id, `${auditor.name} raised finding ${finding.name}`),
      this.rel(finding.id, 'scoped_to_project', project.id, `finding ${finding.name} is scoped to project ${project.name}`),
    ]
    this.push('audit_finding', `Audit finding ${finding.name}`, text, relations)
  }

  /** The vendor half of a finding — a separate document, so vendor+project needs both. */
  private emitVendorAttribution(ordinal: number): void {
    const finding = this.spread(this.world.auditFindings, ordinal, 7)
    const vendor = this.spread(this.world.vendors, ordinal, 11)
    const warehouse = this.spread(this.world.warehouses, ordinal + 1, 7)
    const text = sentences(
      `Vendor attribution note for ${finding.name} names ${vendor.name} as the vendor in scope, based on the lot received at ${warehouse.name}.`,
      `Attribution is decided by the receiving site and is deliberately not repeated in the finding's own narrative.`,
      `A second attribution note issued later in the same quarter would supersede this one.`,
    )
    const relations = [
      this.rel(finding.id, 'against_vendor', vendor.id, `finding ${finding.name} names vendor ${vendor.name}`),
    ]
    this.push('audit_finding', `Vendor attribution ${finding.name}`, text, relations)
  }

  private emitIncidentReport(ordinal: number): void {
    const incident = this.spread(this.world.incidents, ordinal, 5)
    const reporter = this.spread(this.world.people, ordinal, 13)
    const warehouse = this.spread(this.world.warehouses, ordinal, 7)
    const batch = this.spread(this.world.batches, ordinal, 13)
    const day = this.day(300, 590)
    const text = sentences(
      `${incident.name} was filed by ${reporter.name} on day ${day} covering a damaged pallet at ${warehouse.name}.`,
      `The pallet held part of batch ${batch.name} and the report does not estimate the loss.`,
      `Incident narratives are not adjusted after the fact; a change in facts arrives as a separate report.`,
    )
    const relations = [
      this.rel(reporter.id, 'filed', incident.id, `${reporter.name} filed incident report ${incident.name}`),
      this.rel(incident.id, 'at_warehouse', warehouse.id, `incident report ${incident.name} concerns ${warehouse.name}`),
      this.rel(incident.id, 'involved_batch', batch.id, `incident report ${incident.name} involved batch ${batch.name}`),
    ]
    this.push('incident_report', `Incident report ${incident.name}`, text, relations)
  }

  /**
   * The correction section. Each delivery is first written as on-time, then a
   * memo overturns the timing — but NOT the vendor, the project, or the batch,
   * because the interesting question is "which facts survive a stale read",
   * and a correction that moves everything tests nothing about update handling.
   */
  private emitCorrectionMemo(ordinal: number): void {
    const delivery = this.spread(this.world.deliveries, ordinal, 7)
    const carrier = CARRIERS[ordinal % CARRIERS.length]
    const warehouse = this.spread(this.world.warehouses, ordinal, 7)
    const slip = intBetween(this.rng, 2, 9)
    const correctedDay = this.day(241, 561)
    const text = sentences(
      `Correction to ${delivery.name}: the arrival at ${warehouse.name} logged by ${carrier.carrier} on ${carrier.truck} was day ${correctedDay}, ${slip} days after the reported window.`,
      `The timing recorded on the original delivery note is superseded by this memo, and the shipment is to be treated as late for the intake reconciliation.`,
      `The batch contents, the source vendor, and the receiving project are unchanged by this correction.`,
    )
    const relations = [this.rel(delivery.id, 'was_late', `day-${correctedDay}`, `delivery ${delivery.name} was late on day ${correctedDay}`)]
    const correctionDocId = this.push('correction_memo', `Timing correction ${delivery.name}`, text, relations)

    // Paired by scanning the RELATION GRAPH, not the prose. An earlier version
    // looked for a delivery_note whose text contained the delivery name and then
    // demanded the vendor hop on that same note — but the vendor hop moved to
    // the dock memo, so every pairing silently returned early and the corpus
    // shipped 32 correction memos with an EMPTY `corrections` array. A question
    // generator reading that array would have found nothing to build complex
    // supersession questions from, with no error to explain why.
    const onTime = this.findRelation(delivery.id, 'reported_on_time')
    const fromVendor = this.findRelation(delivery.id, 'from_vendor')
    const forProject = this.findRelation(delivery.id, 'for_project')
    if (!onTime || !fromVendor || !forProject) return
    onTime.rel.retracted = true
    this.corrections.push({
      deliveryId: delivery.id,
      subject: delivery.id,
      predicate: 'arrived_day',
      incorrectDocId: onTime.docId,
      incorrectAssertion: onTime.rel.natural,
      correctDocId: correctionDocId,
      correctAssertion: relations[0].natural,
      projectId: forProject.rel.object,
      vendorId: fromVendor.rel.object,
    })
  }

  /** The document asserting `subject predicate ?`, with its doc id, or null. */
  private findRelation(subject: string, predicate: string): { rel: GroundTruthRelation; docId: string } | null {
    for (let i = 0; i < this.docs.length; i++) {
      const rel = this.docs[i].relations.find((r) => r.subject === subject && r.predicate === predicate)
      if (rel) return { rel, docId: id('doc', i + 1, 4) }
    }
    return null
  }

  /**
   * Documents that positively record the ABSENCE of a fact.
   *
   * A benchmark that only ever asks "what was recorded" cannot tell a retriever
   * that reasons from one that pattern-matches: if every subject has a positive
   * record, the right answer is always "the positive record". These documents
   * exist so a question's correct answer can be "no record exists", with a
   * deliberate near-miss asserting a positive fact about the same subject.
   *
   * The negative is asserted with `no_record_for` over a subject-plus-attribute
   * pair rather than over a bare entity: a bare "nothing was recorded about
   * batch B-0042" would be falsified by the very serial listings in the
   * inventory memos, and a benchmark whose ground truth contradicts its own
   * corpus is worse than no benchmark.
   */
  private emitNegativeEvidence(ordinal: number): void {
    const warehouse = this.spread(this.world.warehouses, ordinal, 7)
    const project = this.spread(this.world.projects, ordinal, 7)
    const inspector = this.spread(this.world.people, ordinal + 11, 13)
    const incident = this.spread(this.world.incidents, ordinal, 5)
    const text = sentences(
      `Reconciliation note for ${project.name}: ${inspector.name} confirms that no incident was filed against ${warehouse.name} for this project during the review window.`,
      `The positive record in ${incident.name} concerns a different project and must not be attached to ${project.name} on the strength of the shared warehouse.`,
      `An absence recorded here is a statement about the reviewed window only, and is not a claim that no incident exists anywhere in the corpus.`,
    )
    const relations = [
      this.rel(project.id, 'no_record_for', incident.id, `no incident was filed for ${project.name} matching ${incident.name}`),
    ]
    this.push('negative_evidence', `Reconciliation ${project.name}`, text, relations)
  }

  /**
   * Off-by-default layer. The inventory memo states the unit count as words
   * and the invoice memo states the amount per unit, so the total is an
   * arithmetic step across two documents that share only a serial id — and the
   * digits a lexical retriever would match (the per-unit amount, the count
   * written as digits) appear in neither the question's phrasing nor the sum.
   */
  private appendUncertaintyLayer(): void {
    for (let i = 0; i < UNCERTAINTY_PAIRS; i++) {
      const serial = this.at(this.world.serials, i * 7 + 5)
      const invoice = this.at(this.world.invoices, i * 3 + 9)
      const batch = this.at(this.world.batches, i * 6 + 2)
      const warehouse = this.at(this.world.warehouses, i + 3)
      const inspector = this.at(this.world.people, i + 59)
      const unitValue = 1000 + intBetween(this.rng, 0, 4000)
      const unitCount = 1000 + intBetween(this.rng, 0, 5200)
      const invoiceTotal = unitValue * unitCount
      const spelledCount = spellNumber(unitCount)
      const text = sentences(
        `Inventory memo ${invoice.name} records that serial ${serial.name} was taken up under ${batch.name} at ${warehouse.name}.`,
        `${inspector.name} counted ${spelledCount} units in the lot described by ${invoice.name}, and the count was taken before a second, larger lot was moved in behind it.`,
        `The memo states no unit price; the price per unit is fixed on the invoice record for this serial.`,
      )
      const relations = [
        this.rel(invoice.id, 'covers_serial', serial.id, `invoice ${invoice.name} covers serial ${serial.name}`),
      ]
      const invoiceText = sentences(
        `Invoice ${invoice.name} lists serial ${serial.name} at a fixed unit price of ${unitValue.toLocaleString('en-US')} IDR.`,
        `The invoice record holds the price per unit and deliberately does not repeat the lot count, which lives on the inventory memo for this serial.`,
        `Vendor and approver are recorded on separate documents and are not repeated here.`,
      )
      const invoiceRelations = [
        this.rel(serial.id, 'priced_by', invoice.id, `serial ${serial.name} is priced by invoice ${invoice.name}`),
      ]
      const spellingDocId = this.push('inventory_memo', `Inventory memo ${invoice.name}`, text, relations)
      const pricingDocId = this.push('invoice_memo', `Unit pricing ${invoice.name}`, invoiceText, invoiceRelations)
      this.uncertainSpellings.push({
        invoiceId: invoice.id,
        serialId: serial.id,
        uncertainDocId: spellingDocId,
        resolvingDocId: pricingDocId,
        serialValue: unitValue,
        invoiceTotal: unitCount,
        sum: invoiceTotal,
      })
    }
  }

  /**
   * Filler shares vendors, warehouses and projects with the hot world, and its
   * sentences are drawn from a small template set, so it produces the exact
   * keyword collisions that make a pure-BM25 ranking over that vocabulary
   * useless: the "filler" doc kind gives the corpus an anchor for entities that
   * would otherwise be mentioned only in an answer-bearing sentence.
   */
  private appendFillers(totalDocs: number): void {
    let ordinal = 0
    while (this.docs.length < totalDocs) {
      this.emitFiller(ordinal)
      ordinal += 1
    }
  }

  private emitFiller(ordinal: number): void {
    this.push('filler', `Admin bulletin ${pad(ordinal + 1, 4)}`, this.fillerText(ordinal))
  }

  /**
   * Filler text is emitted here rather than at the call site so the corpus
   * generator and the standalone filler generator cannot drift: a question set
   * built against one and evaluated against the other would compare prose
   * written by two different functions.
   *
   * `day` is injected because the two entry points drive their own PRNG — the
   * corpus generator must consume the main stream in order, while the filler
   * generator needs a fresh one to stay stable when only the filler count
   * changes.
   */
  private fillerText(ordinal: number, day = this.day(90, 640)): string {
    const vendor = this.spread(this.world.vendors, ordinal, 11)
    const warehouse = this.spread(this.world.warehouses, ordinal + 1, 7)
    const project = this.spread(this.world.projects, ordinal + 3, 7)
    const batch = this.spread(this.world.batches, ordinal + 7, 13)
    const subject = pick(this.rng, FILLER_SUBJECTS)
    const setting = pick(this.rng, FILLER_SETTINGS)
    if (ordinal % 3 === 0) {
      return sentences(
        `${subject} at ${setting} was tendered on day ${day} and the bid evaluation is still open.`,
        `${vendor.name} is listed as an interested supplier for administrative purposes only, and no goods or services are in scope for any of the ${WAREHOUSE_COUNT} warehouses.`,
        `Interested-supplier lists are cleared each quarter and are not procurement commitments.`,
      )
    }
    if (ordinal % 3 === 1) {
      return sentences(
        `Facilities note: the ${subject} covering ${setting} names no vendor and no project.`,
        `For reference, ${warehouse.name} and ${project.name} use the same door-access schedule, which is why both appear in the distribution list.`,
        `Distribution lists are not evidence of a delivery, an approval, or a payment.`,
      )
    }
    return sentences(
      `Cross-site logistics reminder for ${setting}: any pallet moved at ${warehouse.name} under ${batch.name} follows the standard uplift procedure.`,
      `${vendor.name} and ${project.name} are printed on the reminder header as standing contacts, not as parties to the movement.`,
      `The reminder restates an existing procedure and creates no new record.`,
    )
  }

  /** Filler-only documents, for callers growing an existing corpus. */
  fillerDocuments(count: number, startOrdinal: number): CorpusDocument[] {
    const out: CorpusDocument[] = []
    for (let i = 0; i < count; i++) {
      const ordinal = startOrdinal + i
      out.push({
        id: id('doc', this.docs.length + i + 1, 4),
        title: `Admin bulletin ${pad(ordinal + 1, 4)}`,
        kind: 'filler',
        text: this.fillerText(ordinal, intBetween(this.rng, 90, 640)),
        entityIds: [],
        entityNames: [],
      })
    }
    return out
  }

  result(): {
    docs: MutableDoc[]
    namesById: Record<string, string>
    world: CorpusWorld
    uncertainSpellings: UncertaintyGroundTruth[]
    corrections: CorrectionGroundTruth[]
  } {
    return {
      docs: this.docs,
      namesById: this.namesById,
      world: this.world,
      uncertainSpellings: this.uncertainSpellings,
      corrections: this.corrections,
    }
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * A document mentions an entity when its triples name it. Deriving mentions
 * from triples (not from string search over the prose) keeps `entityIds`
 * exactly aligned with the asserted facts, which is what a question generator
 * needs: an entity that appears in prose without a triple cannot answer
 * anything, and listing it would create questions with no ground truth.
 */
function entitySetOf(doc: MutableDoc, namesById: Record<string, string>): { ids: string[]; names: string[] } {
  const ids: string[] = []
  const names: string[] = []
  const push = (entityId: string) => {
    if (entityId.startsWith('day-')) return
    if (ids.includes(entityId)) return
    const name = namesById[entityId]
    if (!name) return
    ids.push(entityId)
    names.push(name)
  }
  push(doc.relations.length > 0 ? doc.relations[0].subject : '')
  for (const rel of doc.relations) {
    push(rel.subject)
    push(rel.object)
  }
  return { ids, names }
}

function countSentences(text: string): number {
  const matches = text.match(/[.!?](\s|$)/g)
  return matches ? matches.length : 0
}

function buildIndex(
  docs: MutableDoc[],
  namesById: Record<string, string>,
  world: CorpusWorld,
  seed: number,
): CorpusIndex {
  const mentions = new Map<string, number>()
  const entries: CorpusIndexEntry[] = []
  const relations: GroundTruthRelation[] = []

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]
    const docId = id('doc', i + 1, 4)
    const entities = entitySetOf(doc, namesById)
    for (const entityId of entities.ids) mentions.set(entityId, (mentions.get(entityId) ?? 0) + 1)
    entries.push({ id: docId, kind: doc.kind, entityIds: entities.ids, relations: doc.relations })
    for (const rel of doc.relations) relations.push(rel)
  }

  const hotCount = docs.filter((d) => d.kind !== 'filler').length
  const namedDocs: CorpusDocument[] = docs.map((doc, i) => ({
    id: id('doc', i + 1, 4),
    title: doc.title,
    kind: doc.kind,
    text: doc.text,
    entityIds: entries[i].entityIds,
    entityNames: entitySetOf(doc, namesById).names,
  }))

  const highFrequencyEntities = [...mentions.entries()]
    .filter(([entityId, count]) => count >= 20 && !entityId.startsWith('day-'))
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
    .slice(0, 25)
    .map(([entityId]) => entityId)

  return {
    seed,
    entityIds: {
      vendors: world.vendors.map((e) => e.id),
      people: world.people.map((e) => e.id),
      projects: world.projects.map((e) => e.id),
      warehouses: world.warehouses.map((e) => e.id),
      invoices: world.invoices.map((e) => e.id),
      purchaseOrders: world.purchaseOrders.map((e) => e.id),
      batches: world.batches.map((e) => e.id),
      serials: world.serials.map((e) => e.id),
      auditFindings: world.auditFindings.map((e) => e.id),
      incidents: world.incidents.map((e) => e.id),
      deliveries: world.deliveries.map((e) => e.id),
      approvals: world.approvals.map((e) => e.id),
    },
    namesById,
    entitiesByType: {
      vendor: world.vendors.map((e) => e.id),
      person: world.people.map((e) => e.id),
      project: world.projects.map((e) => e.id),
      warehouse: world.warehouses.map((e) => e.id),
      invoice: world.invoices.map((e) => e.id),
      purchase_order: world.purchaseOrders.map((e) => e.id),
      batch: world.batches.map((e) => e.id),
      serial: world.serials.map((e) => e.id),
      audit_finding: world.auditFindings.map((e) => e.id),
      incident: world.incidents.map((e) => e.id),
      delivery: world.deliveries.map((e) => e.id),
      approval: world.approvals.map((e) => e.id),
    },
    documents: entries,
    relations,
    uncertainSpellings: [],
    corrections: [],
    highFrequencyEntities,
    stats: {
      docs: namedDocs.length,
      hotDocs: hotCount,
      fillerDocs: namedDocs.length - hotCount,
      chars: namedDocs.reduce((sum, d) => sum + d.text.length, 0),
      sentences: namedDocs.reduce((sum, d) => sum + countSentences(d.text), 0),
      relationCount: relations.length,
      distinctEntities: mentions.size,
    },
  }
}

/**
 * The one entry point. Index entries, `entityIds`, and the correction examples
 * all carry document ids (`doc-####`), which are positional — so filler is
 * generated AFTER the hot world and never interleaved, or adding filler would
 * renumber every document a question already refers to.
 */
export function generateCorpus(options: CorpusOptions = {}): Corpus {
  const seed = options.seed ?? 20240917
  const totalDocs = options.totalDocs ?? HOT_DOCS
  const includeFillers = options.includeFillers ?? true
  const includeCorrections = options.includeCorrections ?? true
  const includeUncertainQuantities = options.includeUncertainQuantities ?? false
  const includeIndex = options.includeIndex ?? true

  const builder = new CorpusBuilder(seed)
  const mutable = builder.generate({ totalDocs, includeFillers, includeCorrections, includeUncertainQuantities })
  const { namesById, world, uncertainSpellings, corrections } = builder.result()
  const docs: CorpusDocument[] = mutable.map((doc, i) => {
    const entities = entitySetOf(doc, namesById)
    return {
      id: id('doc', i + 1, 4),
      title: doc.title,
      kind: doc.kind,
      text: doc.text,
      entityIds: entities.ids,
      entityNames: entities.names,
    }
  })

  if (!includeIndex) return { docs }

  const index = buildIndex(mutable, namesById, world, seed)
  index.uncertainSpellings = uncertainSpellings
  index.corrections = corrections
  return { docs, index }
}

/**
 * Filler-only entry point, for growing an existing corpus with more
 * question-neutral mass without touching the answer-bearing half. Ids continue
 * past `startOrdinal` so a caller can concatenate chunks without collisions.
 *
 * Fillers carry no relations, so they never appear in `index.documents` and a
 * question generator can ignore them entirely — they exist only to crowd the
 * retrieval pool and to pad `distinctEntities` with entities that a wide-recall
 * retriever will keep pulling in.
 */
export function generateFiller(options: { seed?: number; count: number; startOrdinal?: number } = { count: 0 }): CorpusDocument[] {
  const seed = options.seed ?? 20240917
  const count = Math.max(0, Math.floor(options.count))
  const startOrdinal = options.startOrdinal ?? 0
  const builder = new CorpusBuilder(seed)
  return builder.fillerDocuments(count, startOrdinal)
}

/** Aggregate counts per entity type, for the CLI summary. */
export function summarizeEntities(index: CorpusIndex): Record<EntityType, number> {
  const out = {} as Record<EntityType, number>
  for (const key of Object.keys(index.entitiesByType) as EntityType[]) {
    out[key] = index.entitiesByType[key].length
  }
  return out
}

function parseFlag(args: string[], flag: string): string | undefined {
  const withEquals = args.find((a) => a.startsWith(`--${flag}=`))
  if (withEquals) return withEquals.split('=').slice(1).join('=')
  const at = args.indexOf(`--${flag}`)
  if (at >= 0 && at + 1 < args.length) return args[at + 1]
  return undefined
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const seed = parseInt(parseFlag(argv, 'seed') ?? '20240917', 10)
  const totalDocs = parseInt(parseFlag(argv, 'docs') ?? String(HOT_DOCS), 10)
  const out = parseFlag(argv, 'out')
  const noCorrections = argv.includes('--no-corrections')
  const withUncertain = argv.includes('--with-uncertain')
  const noFillers = argv.includes('--no-fillers')

  if (!Number.isFinite(seed) || !Number.isFinite(totalDocs)) {
    console.error(
      'Usage: bun benchmark/cognee-corpus.ts --out=/tmp/corpus.json --docs=1200 [--seed=N] [--no-corrections] [--with-uncertain] [--no-fillers]',
    )
    process.exit(1)
  }
  if (totalDocs < HOT_DOCS) {
    console.warn(
      `warning: --docs=${totalDocs} is below the ${HOT_DOCS}-document hot world, so the corpus carries fewer relations than a full world. Ground truth is emitted for exactly what was generated.`,
    )
  }

  const corpus = generateCorpus({
    seed,
    totalDocs,
    includeFillers: !noFillers,
    includeCorrections: !noCorrections,
    includeUncertainQuantities: withUncertain,
  })
  const index = corpus.index!

  const perType = summarizeEntities(index)
  console.log(`docs: ${corpus.docs.length} (hot ${index.stats.hotDocs}, filler ${index.stats.fillerDocs})`)
  console.log(`characters: ${index.stats.chars}`)
  console.log(`sentences: ${index.stats.sentences}`)
  console.log(`relations: ${index.stats.relationCount}`)
  console.log(`distinct entities: ${index.stats.distinctEntities}`)
  console.log('entities per type:')
  for (const key of Object.keys(perType) as EntityType[]) {
    console.log(`  ${key}: ${perType[key]}`)
  }
  console.log('sample (first 3 documents):')
  for (const doc of corpus.docs.slice(0, 3)) {
    console.log(`  [${doc.id}] ${doc.title} :: ${doc.text}`)
  }

  if (!out) {
    console.log('\n(no --out given; nothing written)')
    return
  }
  const payload = JSON.stringify(
    {
      version: 1,
      generator: 'benchmark/cognee-corpus.ts',
      seed,
      docs: corpus.docs,
      index: { ...index, stats: { ...index.stats } },
    },
    null,
    2,
  )
  const { writeFileSync, mkdirSync } = await import('fs')
  const { dirname } = await import('path')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, payload)
  console.log(`\nwrote ${out} (${payload.length} bytes)`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
