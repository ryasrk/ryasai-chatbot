/**
 * Ukur token speed nyata lewat 9router (selalu SSE).
 * Metrik: TTFT (time to first token), total latency, token/s.
 */
import { appendFileSync, readFileSync } from 'node:fs'
const emit=(m:string)=>appendFileSync('/tmp/tspeed.txt',m+'\n')
const BASE='http://localhost:20128/v1'
const API_KEY=readFileSync('/tmp/nine.key','utf8').trim()

async function measure(model:string, prompt:string, maxTokens=200){
  const t0=Date.now()
  const r=await fetch(`${BASE}/chat/completions`,{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${API_KEY}`},
    body:JSON.stringify({model,messages:[{role:'user',content:prompt}],max_tokens:maxTokens,stream:true}),
  })
  if(!r.ok) return {ok:false,err:`${r.status} ${(await r.text()).slice(0,100)}`}
  let ttft=0, text='', chunks=0, usage:any=null
  const reader=r.body!.getReader(); const dec=new TextDecoder(); let buf=''
  while(true){
    const {done,value}=await reader.read(); if(done) break
    buf+=dec.decode(value,{stream:true})
    const parts=buf.split('\n'); buf=parts.pop() ?? ''
    for(const line of parts){
      if(!line.startsWith('data: ')) continue
      const payload=line.slice(6).trim()
      if(payload==='[DONE]') continue
      try{
        const j=JSON.parse(payload)
        if(j.usage) usage=j.usage
        const d=j.choices?.[0]?.delta?.content
        if(d){ if(!ttft) ttft=Date.now()-t0; text+=d; chunks++ }
      }catch{}
    }
  }
  const total=Date.now()-t0
  const genMs=Math.max(total-ttft,1)
  const ct=usage?.completion_tokens ?? chunks
  return {ok:true,ttft,total,chunks,completion:ct,promptTok:usage?.prompt_tokens??0,
          tps: ct>0 ? (ct/(genMs/1000)) : 0, text:text.slice(0,60).replace(/\n/g,' ')}
}
async function main(){
  emit('=== TOKEN SPEED NYATA (9router, port 20128) ===')
  emit('')
  const models=['ag/gemini-3.8-flash-low','lim/glm-5.2-fast']
  const prompts=[
    'Reply with exactly: OK',
    'Explain in 2 sentences what a vector database is.',
    'List 5 benefits of hybrid search. Be brief.',
  ]
  const all:any[]=[]
  for(const m of models){
    emit(`--- ${m} ---`)
    const tps:number[]=[]; const ttfts:number[]=[]
    for(const p of prompts){
      const r=await measure(m,p)
      if(!r.ok){ emit(`  GAGAL: ${r.err}`); continue }
      tps.push(r.tps ?? 0); ttfts.push(r.ttft ?? 0); all.push({model:m,...r,tps:r.tps??0,ttft:r.ttft??0})
      emit(`  TTFT=${String(r.ttft).padStart(4)}ms total=${String(r.total).padStart(5)}ms tok(in=${r.promptTok},out=${r.completion}) -> ${(r.tps??0).toFixed(1)} tok/s`)
      emit(`     "${r.text}"`)
    }
    if(tps.length){
      const a=tps.reduce((x,y)=>x+y,0)/tps.length
      const t=ttfts.reduce((x,y)=>x+y,0)/ttfts.length
      emit(`  RATA-RATA: ${a.toFixed(1)} tok/s | TTFT ${t.toFixed(0)}ms (n=${tps.length})`)
    }
    emit('')
  }
  if(all.length){
    const a=all.reduce((s,r)=>s+r.tps,0)/all.length
    const tt=all.reduce((s,r)=>s+r.ttft,0)/all.length
    const pt=all.reduce((s,r)=>s+r.promptTok,0)
    const ct=all.reduce((s,r)=>s+r.completion,0)
    emit('=== AGREGAT ===')
    emit(`  token speed rata-rata : ${a.toFixed(1)} tok/s`)
    emit(`  TTFT rata-rata        : ${tt.toFixed(0)} ms`)
    emit(`  total prompt tokens   : ${pt}`)
    emit(`  total output tokens   : ${ct}`)
    emit(`  avg tokens/task       : ${((pt+ct)/all.length).toFixed(1)} (in+out per pemanggilan)`)
  }
  process.exit(0)
}
main().catch(e=>{emit('ERR '+String(e).slice(0,200));process.exit(1)})
