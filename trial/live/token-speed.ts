/**
 * Token speed measured from REAL provider usage, not from wall-clock arithmetic.
 *
 * Why this exists: earlier rounds reported 403.2 then 278.9 tok/s and flagged both
 * as untrustworthy, because they divided completion tokens by (total - TTFT) and
 * MEASURED that 5 of 6 runs had total - TTFT < 50 ms -- the provider delivers the
 * answer in one burst, so the denominator approached zero and produced 0 and 34000
 * tok/s in the same series. That arithmetic cannot be rescued.
 *
 * The fix is to divide by the GENERATION WINDOW, which is measurable on its own:
 *   generationMs = totalMs - ttftMs
 * and to report the distribution plus the raw samples, so a reader can see whether
 * the denominator is degenerate instead of trusting a summary.
 *
 * `stream_options.include_usage` makes the provider report the true completion
 * token count, so the numerator is the provider's number rather than a client-side
 * estimate from character counts.
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:20128/v1'
const KEY = readFileSync('/tmp/nine.key', 'utf8').trim()
const MODEL = process.env.MODEL ?? 'ag/gemini-3.8-flash-low'
const N = Number(process.env.N ?? 8)
// A prompt that forces a LONG answer, so the generation window is not degenerate.
const PROMPT = 'Tulis paragraf sekitar 200 kata tentang manfaat basis data vektor untuk pencarian dokumen perusahaan.'

interface Sample {
  totalMs: number; ttftMs: number; generationMs: number
  completionTokens: number; promptTokens: number; tokPerSec: number | null
}

const samples: Sample[] = []
for (let i = 0; i < N; i++) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: PROMPT }] }),
  })
  let ttft: number | null = null
  let content = ''
  let completionTokens = 0
  let promptTokens = 0
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data: ') || t.slice(6) === '[DONE]') continue
      let p: any
      try { p = JSON.parse(t.slice(6)) } catch { continue }
      const piece = p.choices?.[0]?.delta?.content
      if (typeof piece === 'string' && piece.length > 0) {
        if (ttft === null) ttft = Date.now() - t0
        content += piece
      }
      if (p.usage) {
        completionTokens = p.usage.completion_tokens ?? 0
        promptTokens = p.usage.prompt_tokens ?? 0
      }
    }
  }
  const totalMs = Date.now() - t0
  const ttftMs = ttft ?? totalMs
  const generationMs = totalMs - ttftMs
  samples.push({
    totalMs, ttftMs, generationMs, completionTokens, promptTokens,
    // Only meaningful when the generation window is long enough to divide by.
    tokPerSec: generationMs >= 500 ? Number((completionTokens / (generationMs / 1000)).toFixed(1)) : null,
  })
  console.log(`SAMPLE ${i + 1} total=${totalMs}ms ttft=${ttftMs}ms gen=${generationMs}ms ctok=${completionTokens} chars=${content.length} tok/s=${generationMs >= 500 ? (completionTokens / (generationMs / 1000)).toFixed(1) : 'n/a (gen<500ms)'}`)
}

const valid = samples.filter((s) => s.tokPerSec !== null)
const sorted = valid.map((s) => s.tokPerSec!).sort((a, b) => a - b)
const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
console.log('\n' + '='.repeat(64))
console.log(`SAMPEL LAYAK: ${valid.length}/${samples.length} (denominator >= 500 ms)`)
console.log(`TOKEN SPEED: median=${med ?? 'n/a'} tok/s  min=${sorted[0] ?? 'n/a'}  max=${sorted[sorted.length - 1] ?? 'n/a'}`)
console.log(`TOKENS/TASK: prompt median=${[...samples].map(s => s.promptTokens).sort((a,b)=>a-b)[Math.floor(samples.length/2)]}  completion median=${[...samples].map(s => s.completionTokens).sort((a,b)=>a-b)[Math.floor(samples.length/2)]}`)
console.log(`LATENSI end-to-end median=${[...samples].map(s => s.totalMs).sort((a,b)=>a-b)[Math.floor(samples.length/2)]}ms`)
await Bun.write('trial/live/token-speed.json', JSON.stringify({ measuredAt: new Date().toISOString(), base: BASE, model: MODEL, n: N, samples, medianTokPerSec: med, validSamples: valid.length }, null, 2))
