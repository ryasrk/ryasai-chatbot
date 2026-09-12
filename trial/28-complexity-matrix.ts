/** Petakan matriks provider vs fitur. Mana yang benar-benar didukung? */
import { appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/matrix.txt', m + '\n')
import { DB_PROVIDER_PRESETS } from '../src/lib/db-provider-presets'

function main() {
  emit('=== MATRIKS: apa saja yang harus "dipahami" LLM ===')
  emit('')
  emit('1. PROVIDER DATABASE (dari kode):')
  const presets = Object.keys(DB_PROVIDER_PRESETS ?? {})
  emit(`   ${presets.length} preset: ${presets.join(', ')}`)
  emit('')
  emit('2. DIALEK SQL yang harus dibedakan LLM:')
  emit('   PostgreSQL, MySQL, MSSQL, ClickHouse, SQLite(demo)')
  emit('   -> tiap dialek punya aturan berbeda (ILIKE vs LIKE, LIMIT vs TOP, dsb)')
  emit('')
  emit('3. VECTOR STORE:')
  emit('   pgvector (internal), Qdrant, Milvus, Pinecone, Chroma  = 5 backend')
  emit('')
  emit('4. PROVIDER LLM:')
  emit('   OPENAI_COMPATIBLE, ANTHROPIC_COMPATIBLE, OLLAMA, OPENAI')
  emit('')
  emit('5. SUMBER DATA di router:')
  emit('   DATABASE (SQL), DOCUMENTS (RAG), REST_API, CHAT, PLUGIN, MCP')
  emit('')
  emit('=== PERKIRAAN PERMUKAAN KOMBINASI ===')
  const dbs = presets.length, dialect = 5, vec = 5, llm = 4, src = 6
  emit(`   ${dbs} DB x ${dialect} dialek x ${vec} vector x ${llm} LLM x ${src} sumber`)
  const total = dbs * dialect * vec * llm * src
  emit(`   = ~${total.toLocaleString('id-ID')} kombinasi yang SECARA TEORI harus jalan`)
  emit('')
  emit('TAPI: tidak semua kombinasi diuji. Mari cek mana yang punya tes.')
  process.exit(0)
}
main()
