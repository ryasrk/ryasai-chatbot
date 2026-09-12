/** Berapa panggilan LLM untuk SATU pertanyaan? Ini ongkos akurasi. */
import { readFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
const emit = (m: string) => appendFileSync('/tmp/cost.txt', m + '\n')

// Hitung titik panggilan LLM di jalur chat (bukan komentar, bukan tes)
function countCalls(file: string): number {
  const src = readFileSync(file, 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
  const m = code.match(/\b(chatOnce|agentChatOnce|generateSql|generateAnswer|streamAnswer|streamChat|generateChat|rewriteQuery|expandQuery|analyzeIntent|evaluateAnswerConfidence|evaluateEvidenceSufficiency|generateSessionTitle|checkAlignment|generateSchemaDescriptions|enrichSchemaDescriptions)\s*\(/g)
  return m ? m.length : 0
}

function main() {
  emit('=== ONGKOS LLM PER PERTANYAAN (titik panggilan di jalur panas) ===')
  emit('')
  const files = [
    'src/lib/tool-router.ts', 'src/lib/tool-branches.ts', 'src/lib/stream-preparers.ts',
    'src/lib/intent-pipeline.ts', 'src/lib/smart-router.ts', 'src/lib/ai.ts',
    'src/lib/hyde.ts', 'src/lib/alignment-check.ts', 'src/lib/rag.ts',
  ]
  let total = 0
  for (const f of files) {
    try { const n = countCalls(f); total += n; emit(`  ${String(n).padStart(2)}  ${f}`) } catch {}
  }
  emit('')
  emit(`TOTAL titik panggilan LLM di jalur chat: ${total}`)
  emit('')
  emit('=== ARTINYA UNTUK PERTANYAAN ANDA ===')
  emit('Tiap panggilan = 1 round-trip ke LLM pelanggan. Dengan model reasoning')
  emit('yang lambat (6,5 detik seperti diukur sebelumnya), pertanyaan yang')
  emit('menyentuh SEMUA lapisan bisa butuh:')
  emit('  router -> rewrite -> expansion -> (SQL gen -> repair) -> synthesis')
  emit('  = 4-6 panggilan berturut-turut = 26-40 detik')
  emit('')
  emit('Inilah trade-off yang Anda tanyakan: setiap peningkatan akurasi')
  emit('menambah panggilan, dan panggilan menambah latency + biaya token')
  emit('PELANGGAN. Jadi efisiensi dan akurasi memang tarik-menarik di sini.')
  process.exit(0)
}
main()
