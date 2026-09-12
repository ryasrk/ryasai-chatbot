/**
 * Apakah konfigurasi LLM org lain bisa terpakai? Ini bergantung apakah
 * getEmbeddingRuntimeConfig SELALU dipanggil dengan org context.
 */
import { readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const emit = (m: string) => appendFileSync('/tmp/cfgleak.txt', m + '\n')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

function main(){
  const files = [...walk('src/lib'), ...walk('src/app')]
  const callers: string[] = []
  for (const f of files) {
    const s = readFileSync(f, 'utf8')
    if (/getEmbeddingRuntimeConfig\s*\(/.test(s) && !f.includes('smart-router-helpers')) {
      callers.push(f)
    }
  }
  emit('=== PEMANGGIL getEmbeddingRuntimeConfig ===')
  for (const c of callers) emit(`  ${c}`)
  emit('')
  emit(`${callers.length} berkas. Kunci: apakah tiap pemanggil berjalan di dalam`)
  emit('konteks org (enterWithOrg)? Kalau tidak, findFirst melihat SEMUA org.')
  emit('')
  emit('Ini bukan kebocoran kredensial ke KLIEN — hasilnya dipakai server-side')
  emit('untuk memanggil API. Tapi artinya: instalasi dengan >1 org bisa memakai')
  emit('kunci/model org LAIN untuk menghitung embedding org ini. Kalau org A')
  emit('dan B punya kunci berbeda dengan kuota terpisah, biaya org B bisa')
  emit('tertagih ke org A, dan hasil retrieval B dihitung di ruang vektor A.')
  process.exit(0)
}
main()
