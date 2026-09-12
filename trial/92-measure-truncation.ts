/**
 * Ukur kerugian nyata: berapa baris pgvector kembalikan vs yang diminta,
 * pada distribusi tenant yang realistis.
 */
import { PrismaClient } from '@prisma/client'
import { appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/trunc.txt',m+'\n')
const p=new PrismaClient({ datasources:{ db:{ url:'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai' } } })

async function main(){
  await p.$executeRawUnsafe(`DROP TABLE IF EXISTS hnsw_probe`)
  await p.$executeRawUnsafe(`CREATE TABLE hnsw_probe (id serial, tenant int, v vector(8))`)
  await p.$executeRawUnsafe(`CREATE INDEX ON hnsw_probe USING hnsw (v vector_cosine_ops)`)

  const N = 20000
  const rows: string[] = []
  for (let i=0;i<N;i++){
    const t = i % 100
    const arr = Array.from({length:8},(_,k)=>((Math.sin(i*(k+1)*12.9898)*43758.5453)%1).toFixed(6))
    rows.push(`(${t},'[${arr.join(',')}]')`)
  }
  // insert bertahap supaya tidak kena limit parameter
  for (let i=0;i<rows.length;i+=2000){
    await p.$executeRawUnsafe(`INSERT INTO hnsw_probe (tenant,v) VALUES ${rows.slice(i,i+2000).join(',')}`)
  }
  await p.$executeRawUnsafe(`ANALYZE hnsw_probe`)
  emit(`tabel: ${N} vektor, 100 tenant (masing-masing 1% = ${N/100} baris)`)
  emit('')

  const q = `'[${Array.from({length:8},(_,k)=>(0.5+k*0.01).toFixed(6)).join(',')}]'`
  emit('=== topK*8 = 80 diminta, tenant = 1% dari tabel ===')
  for (const ef of [40, 80, 200, 1000]) {
    const r = await p.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${ef}`)
      return tx.$queryRawUnsafe<Array<{n:bigint}>>(
        `SELECT count(*) AS n FROM (
           SELECT id FROM hnsw_probe WHERE tenant = 7 ORDER BY v <=> ${q}::vector LIMIT 80
         ) s`)
    })
    emit(`  ef_search=${String(ef).padStart(4)} -> ${String(r[0].n).padStart(2)}/80 baris`)
  }
  emit('')
  const total = await p.$queryRawUnsafe<Array<{n:bigint}>>(`SELECT count(*) AS n FROM hnsw_probe WHERE tenant=7`)
  emit(`(tenant 7 punya ${total[0].n} baris di tabel, jadi 80 seharusnya tersedia)`)
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,300));process.exit(1)})
