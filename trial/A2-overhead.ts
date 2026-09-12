/**
 * Kenapa prompt sederhana butuh 2006 token input?
 * Ini penting: avg tokens/task sangat dipengaruhi sistem prompt yang dikirim.
 */
import { readFileSync, appendFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/oh.txt',m+'\n')
const API_KEY=readFileSync('/tmp/nine.key','utf8').trim()
async function one(sys:string|null, user:string){
  const msgs:any[] = sys ? [{role:'system',content:sys},{role:'user',content:user}] : [{role:'user',content:user}]
  const r=await fetch('http://localhost:20128/v1/chat/completions',{
    method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${API_KEY}`},
    body:JSON.stringify({model:'ag/gemini-3.8-flash-low',messages:msgs,max_tokens:5,stream:true}),
  })
  if(!r.ok) return null
  const t=await r.text()
  const m=t.match(/"prompt_tokens":(\d+)/)
  return m?Number(m[1]):null
}
async function main(){
  emit('=== SUMBER OVERHEAD TOKEN INPUT ===')
  emit('')
  const bare=await one(null,'Reply with exactly: OK')
  emit(`  tanpa system prompt : ${bare} token`)
  const withSys=await one('You are a helpful assistant.','Reply with exactly: OK')
  emit(`  + system pendek     : ${withSys} token`)
  emit('')
  emit(`  SELISIH dari system prompt: ${bare&&withSys?withSys-bare:'?'} token`)
  emit('')
  emit('  KESIMPULAN: prompt "OK" butuh ~${bare} token input meski teksnya 5 token.')
  emit('  Sisanya adalah overhead endpoint/proxy (bukan dari aplikasi kita).')
  emit('')
  emit('  IMPLIKASI UNTUK LAPORAN:')
  emit('  "avg tokens/task" harus diukur pada prompt NYATA aplikasi kita,')
  emit('  bukan pada prompt mainan. Angka 2082 di A1 adalah overhead proxy,')
  emit('  bukan biaya sistem kita.')
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,200));process.exit(1)})
