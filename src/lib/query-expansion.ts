/**
 * Deterministic query expansion for retrieval: bilingual (Indonesian ↔ English) business synonyms, applied without
 * an LLM call so a question phrased in one language still reaches a document written in the other. Pure data and
 * one function; `intent-pipeline.ts` decides when expansion runs and merges the results.
 */

// ponytail: common English↔Indonesian synonyms for enterprise terms.
// NOT database-specific — generic business vocabulary.
const QUERY_SYNONYMS: Record<string, string[]> = {
  leave: ['annual leave', 'vacation', 'cuti', 'cuti tahunan', 'time off'],
  policy: ['procedure', 'guideline', 'rule', 'kebijakan', 'prosedur'],
  invoice: ['bill', 'faktur', 'tagihan'],
  employee: ['staff', 'worker', 'karyawan', 'pegawai'],
  customer: ['client', 'pelanggan', 'nasabah'],
  product: ['item', 'produk', 'barang'],
  order: ['purchase', 'pesanan', 'pembelian'],
  salary: ['pay', 'compensation', 'gaji', 'upah'],
  revenue: ['income', 'sales', 'pendapatan'],
  report: ['summary', 'laporan', 'ringkasan'],
  approval: ['authorize', 'persetujuan', 'persetujuan'],
  request: ['application', 'permohonan', 'pengajuan'],
  meeting: ['session', 'rapat', 'pertemuan'],
  budget: ['funding', 'anggaran', 'dana'],
  contract: ['agreement', 'kontrak', 'perjanjian'],
  training: ['course', 'pelatihan', 'kursus'],
  performance: ['evaluation', 'kinerja', 'penilaian'],
  recruitment: ['hiring', 'rekrutmen', 'penerimaan'],
  reimbursement: ['expense', 'refund', 'penggantian'],
  travel: ['trip', 'perjalanan', 'dinas'],
  // ponytail: ADDED by the 2026-09 cross-lingual trial. These are the terms the
  // measured failures actually needed; the map above is English-keyed so an
  // Indonesian query could never reach it (see expandQuery). Keep entries in the
  // SAME shape — the reverse index below derives the Indonesian→English
  // direction automatically, so never add a second hand-written table.
  overtime: ['lembur'],
  rate: ['tarif', 'besaran'],
  working: ['kerja'],
  holiday: ['libur', 'hari libur'],
  day: ['hari'],
  annual: ['tahunan'],
  carryover: ['carry over', 'sisa', 'dibawa'],
  refund: ['pengembalian', 'penggantian'],
  purchase: ['pembelian', 'pembayaran'],
  tender: ['tender', 'lelang'],
  threshold: ['batas', 'ambang'],
  security: ['keamanan'],
  breach: ['kebocoran', 'insiden'],
  access: ['akses'],
  term: ['termin'],
  deadline: ['batas waktu'],
  wage: ['upah'],
  processing: ['proses', 'pemrosesan'],
  update: ['pembaruan'],
}

/**
 * Reverse index: Indonesian/variant term → the canonical key it belongs to.
 *
 * WHY (2026-09 cross-lingual trial, `trial/14-crosslingual.ts`): documents are
 * routinely authored in English (vendor handbooks, ISO policies) while users ask
 * in Indonesian. `expandQuery` only looked up `QUERY_SYNONYMS[token]`, i.e. the
 * ENGLISH key — so "berapa tarif lembur?" tokenized to tarif/lembur/hari/kerja,
 * none of which is a key, and expansion returned the query unchanged.
 * Measured: 5 of 11 Indonesian questions retrieved NOTHING (0 chunks) even though
 * the answer was present in the corpus, and the run scored 58% retrieval overall
 * against 100% for English phrasing. With no embedding provider configured the
 * lexical path is the only one left, so this bridge is load-bearing.
 *
 * Built from QUERY_SYNONYMS so the two directions cannot drift.
 */
const SYNONYM_REVERSE: Record<string, string[]> = (() => {
  const rev: Record<string, Set<string>> = {}
  for (const [key, syns] of Object.entries(QUERY_SYNONYMS)) {
    // The key itself is a canonical term for its own concept.
    ;(rev[key] ??= new Set()).add(key)
    for (const syn of syns) {
      const norm = syn.toLowerCase().trim()
      if (!norm) continue
      ;(rev[norm] ??= new Set()).add(key)
      // Multi-word synonyms contribute each content word, so "cuti tahunan"
      // makes both "cuti" and "tahunan" reach the `leave` concept.
      //
      // CAUTION: this is lossy for AMBIGUOUS words. "hari libur" (holiday)
      // contributes the bare word "hari", which collides with "hari" = day —
      // and once `hari` reached the `holiday` concept, translating
      // "Berapa hari proses refund..." produced "...holiday processing refund...",
      // which matched nothing. A regression measured in trial/14-crosslingual.ts
      // (refund-processing went hit -> miss). Sub-splitting therefore records the
      // word ONLY under the key it belongs to, and a later key that owns the word
      // as a PRIMARY synonym wins; see EXACT_ONLY below for how the translator
      // resolves the ambiguity.
      if (norm.includes(' ')) {
        for (const part of norm.split(/\s+/)) {
          if (part.length >= 3) (rev[part] ??= new Set()).add(key)
        }
      }
    }
  }
  return Object.fromEntries(
    Object.entries(rev).map(([k, v]) => [k, [...v]]),
  )
})()

/**
 * Words that are a PRIMARY (single-word) synonym of exactly one concept.
 *
 * A word reachable only by splitting a multi-word phrase ("hari" out of
 * "hari libur") must not outrank a word that is a concept's own exact synonym
 * ("hari" for `day`). Without this, "Berapa hari proses refund…" translated to
 * "…holiday processing refund…" and matched nothing.
 */
const PRIMARY_SYNONYM: Record<string, string[]> = (() => {
  const primary: Record<string, string[]> = {}
  for (const [key, syns] of Object.entries(QUERY_SYNONYMS)) {
    primary[key] = [key]
    for (const syn of syns) {
      const norm = syn.toLowerCase().trim()
      if (norm && !norm.includes(' ')) (primary[norm] ??= []).push(key)
    }
  }
  return primary
})()

export function expandQuery(query: string): string[] {
  const lower = query.toLowerCase()
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
  const expansions = [query]
  const seen = new Set<string>([query])

  const push = (candidate: string) => {
    if (candidate !== lower && !seen.has(candidate)) {
      seen.add(candidate)
      expansions.push(candidate)
    }
  }

  // Fully-translated variant FIRST — this is what actually retrieves from an
  // English corpus. Substituting one token at a time yields mixed-language
  // strings ("berapa tarif lembur pada day kerja?") whose remaining Indonesian
  // words match nothing, so they score no better than the original; measured in
  // trial/14-crosslingual.ts. Each token is mapped to its best English concept
  // and the whole query is rewritten, so English content words dominate.
  const translated = tokens.map((t) => {
    if (QUERY_SYNONYMS[t]) return t // already English
    // A word that is some concept's exact single-word synonym resolves to that
    // concept only — never to a concept that merely happens to contain it inside
    // a multi-word phrase.
    const exact = PRIMARY_SYNONYM[t]
    if (exact && exact.length === 1) return exact[0]
    const concepts = SYNONYM_REVERSE[t]
    return concepts?.find((c) => !c.includes(' ')) ?? concepts?.[0] ?? t
  })
  if (translated.some((t, i) => t !== tokens[i])) {
    push(translated.join(' '))
  }

  for (const token of tokens) {
    // Forward direction: an English token expands to its Indonesian variants.
    const syns = QUERY_SYNONYMS[token]
    if (syns) {
      for (const syn of syns) push(lower.replace(new RegExp(`\\b${token}\\b`, 'g'), syn))
      continue
    }
    // Reverse direction: an Indonesian/variant token expands to the canonical
    // English concept word, which is what the English corpus actually contains.
    const concepts = SYNONYM_REVERSE[token]
    if (concepts) {
      for (const concept of concepts) {
        push(lower.replace(new RegExp(`\\b${token}\\b`, 'g'), concept))
      }
    }
  }

  return expansions
}

// ---------------------------------------------------------------------------
// Multi-pass retrieval with query expansion + reflection.
// ----------------------------------------------------------------------------
// This is the production retrieval orchestrator that wraps the base
// retrieveRelevantChunks with:
//   1. Query expansion — synonym + multilingual variants for better recall
//   2. Reflection — LLM evaluates if evidence is sufficient to answer
//   3. Multi-turn — if reflection says insufficient, retrieves again with 2x topK
//
// Returns the same shape as retrieveRelevantChunks plus reflection metadata.
// ----------------------------------------------------------------------------
