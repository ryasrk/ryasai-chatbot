/**
 * Subsystem trial: vector search, DB knowledge, routing, tenancy, agentic.
 * LLM-independent measurements only (see trial/README.md).
 */
import { db } from '../src/lib/db'
import { chunkText, extractKeywords, scoreChunk, tokenize } from '../src/lib/rag'
import { retrieveRelevantChunks } from '../src/lib/rag'
import { generateSql } from '../src/lib/ai'
import { validateAndSanitizeLlmSql } from '../src/lib/guardrails'
import { toolRunTypeFor } from '../src/lib/tool-router-agentic'
import { createTrialOrg, dropTrialOrg, inOrg, pct, hr } from './lib'

async function main() {
  hr('SUBSYSTEM TRIAL')
  const a = await createTrialOrg(`trial-a-${Date.now().toString(36)}`)
  const b = await createTrialOrg(`trial-b-${Date.now().toString(36)}`)
  console.log(`org A=${a.organizationId}\norg B=${b.organizationId}`)

  // ---- tenancy ----
  hr('1. TENANT ISOLATION (real DB, real extension)')
  await inOrg(a, () =>
    db.document.create({
      data: {
        organizationId: a.organizationId, name: 'A-secret.txt', type: 'TEXT',
        sizeBytes: 10, mimeType: 'text/plain', status: 'ready', isEnabled: true,
        contentText: 'ALPHA-ONLY-SECRET-MARKER',
      },
    }),
  )
  const seenByA = await inOrg(a, () => db.document.count())
  const seenByB = await inOrg(b, () => db.document.count())
  const leak = await inOrg(b, () => db.document.findMany({ select: { contentText: true } }))
  const leaked = leak.some((d) => d.contentText.includes('ALPHA-ONLY-SECRET-MARKER'))
  console.log(`A sees ${seenByA} doc(s), B sees ${seenByB} doc(s)`)
  console.log(`cross-tenant leak: ${leaked ? 'YES — FAIL' : 'no'}`)

  const retA = await inOrg(a, () => retrieveRelevantChunks({ query: 'ALPHA SECRET MARKER', topK: 5 }))
  const retB = await inOrg(b, () => retrieveRelevantChunks({ query: 'ALPHA SECRET MARKER', topK: 5 }))
  const retLeak = retB.chunks.some((c) => c.content.includes('ALPHA-ONLY-SECRET-MARKER'))
  console.log(`A retrieval hits=${retA.chunks.length} · B retrieval hits=${retB.chunks.length} · leak in retrieval: ${retLeak ? 'YES — FAIL' : 'no'}`)

  // ---- vector / scoring ----
  hr('2. VECTOR + LEXICAL SCORING')
  const chunks = chunkText(
    'Kebijakan retur barang berlaku 30 hari sejak tanggal pembelian. ' +
      'Retur wajib menyertakan nota asli. Barang elektronik tidak dapat diretur.',
  )
  console.log(`chunkText produced ${chunks.length} chunk(s) from a 3-sentence paragraph`)
  const tk = tokenize('Kebijakan retur barang 30 hari')
  console.log(`tokenize -> ${tk.length} tokens: ${tk.slice(0, 8).join(', ')}`)
  const onTopic = scoreChunk(tk, { content: chunks[0], keywords: extractKeywords(chunks[0], 8) })
  const offTopic = scoreChunk(tk, { content: 'Jadwal rapat direksi triwulanan.', keywords: '' })
  console.log(`on-topic total=${onTopic.total.toFixed(3)} · off-topic total=${offTopic.total.toFixed(3)}`)
  console.log(`on-topic ranks above off-topic: ${onTopic.total > offTopic.total ? 'yes' : 'NO — FAIL'}`)

  // ---- guardrail round-trip ----
  hr('3. SQL GUARDRAIL ROUND-TRIP')
  const payloads: Array<[string, string, boolean]> = [
    ['plain select', 'SELECT id FROM users LIMIT 5', true],
    ['drop table', 'DROP TABLE users', false],
    ['pg_read_file', "SELECT pg_read_file('/etc/passwd')", false],
    ['sleep', 'SELECT pg_sleep(5)', false],
    ['literal decoy', "SELECT 'pg_read_file(' AS note FROM users", true],
    ['mutation hidden in comment', 'SELECT 1 -- ; DROP TABLE users', false],
  ]
  let gPass = 0
  for (const [name, sql, wantOk] of payloads) {
    const r = validateAndSanitizeLlmSql(sql)
    const ok = r.ok === wantOk
    if (ok) gPass += 1
    console.log(`${ok ? 'OK  ' : 'WRONG'} ${name.padEnd(28)} allowed=${String(r.ok).padEnd(5)} expected=${wantOk}`)
  }
  console.log(`guardrail: ${gPass}/${payloads.length} correct`)

  // ---- toolRun type mapping ----
  hr('4. ToolRun TYPE MAPPING (metrics integrity)')
  const valid = new Set(['RAG', 'SQL', 'REST_API', 'CHAT', 'PLUGIN'])
  const tools = ['rag_search', 'sql_query', 'rest_api', 'web_fetch', 'plugin:weather', 'mcp:foo', 'unknown_thing']
  let tPass = 0
  for (const t of tools) {
    const mapped = toolRunTypeFor(t)
    const ok = valid.has(mapped)
    if (ok) tPass += 1
    console.log(`${ok ? 'OK  ' : 'WRONG'} ${t.padEnd(16)} -> ${mapped}`)
  }
  console.log(`toolRunTypeFor: ${tPass}/${tools.length} map to a valid metrics literal`)

  hr('SUMMARY')
  console.log(`tenant isolation      : ${leaked || retLeak ? 'FAIL' : 'pass'}`)
  console.log(`scoring ranks on-topic: ${onTopic.total > offTopic.total ? 'pass' : 'FAIL'}`)
  console.log(`guardrail             : ${pct(gPass, payloads.length)}`)
  console.log(`toolRun type mapping  : ${pct(tPass, tools.length)}`)

  await dropTrialOrg(a.organizationId)
  await dropTrialOrg(b.organizationId)
  console.log('\ncleaned up')
  process.exit(0)
}

main().catch((e) => { console.error('TRIAL FAILED:', e); process.exit(1) })
