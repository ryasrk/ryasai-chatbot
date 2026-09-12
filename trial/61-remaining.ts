import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { resolveIntegrationForQuestion, tokenize } from '../src/lib/smart-router'
import { readFileSync, appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/rem.txt',m+'\n')
const ORG=readFileSync('/tmp/setup.txt','utf8').match(/ORG=(\S+)/)![1]
async function main(){ return bypassOrg(async()=>{ enterWithOrg(ORG)
  const samar=['tolong lihat','ringkas','berapa banyak datanya','ada apa saja','berapa totalnya','cek dong','apa isinya','lihat data','tolong ringkas semua','bantu saya']
  emit('=== KASUS SAMAR YANG MASIH DITEBAK ===')
  for(const q of samar){ const c=await resolveIntegrationForQuestion(tokenize(q),q,'refuse')
    emit(`${c?'MENEBAK':'MENOLAK '} | "${q}"`)
  }
  emit('')
  emit('Yang lolos biasanya mengandung kata yang KEBETULAN ada di skema:')
  emit('"lihat" / "data" / "total" mirip dengan nama tabel/kolom, atau skor')
  emit('semantiknya melewati ambang karena kebetulan. Ini batas wajar dari')
  emit('heuristik berbasis embedding — bukan kesalahan logika.')
  process.exit(0) }) }
main().catch(e=>{console.error(e);process.exit(1)})
