/**
 * How large is the prompt the APPLICATION builds?
 *
 * `LlmUsageLog.promptTokens` reports ~2,000 tokens per task, but MEASURED directly
 * against the provider, a 1-character prompt already reports 2,002 prompt tokens.
 * The gap is the gateway's own preamble, which our code never sends, so reporting
 * the raw figure as "our cost per task" would overstate it by roughly 20x.
 *
 * This measures OUR contribution instead: it renders the exact message array that
 * `streamChat()` sends and counts its characters, so the number is attributable to
 * our prompt construction rather than to a proxy's overhead. Characters are the
 * honest unit here -- we have no tokenizer for the provider's model, and claiming
 * a token count would require one. The estimate uses ~4 chars/token and is labelled
 * as an estimate wherever it is reported.
 */
import { readFileSync } from 'node:fs'

const SYSTEM_CHAT =
  'You are ryasai, an enterprise AI assistant. ' +
  'You can help with: database queries (SQL), document search (RAG), REST API calls, and general chat. ' +
  'When the user refers to prior conversation or data, use the conversation history to answer without needing a new query. ' +
  'If the user provides new information, acknowledge and remember it. ' +
  'Do not say data is unavailable if it was discussed in prior conversation history.'

// The questions the app was driven with for the per-task measurement.
const QUESTIONS = ['Sebutkan ibukota Jepang.', 'Berapa 17 kali 23?', 'Apa mata uang Indonesia?']

const rows = QUESTIONS.map((q) => {
  const systemChars = SYSTEM_CHAT.length
  const userChars = q.length
  return { question: q, systemChars, userChars, totalChars: systemChars + userChars, estTokens: Math.ceil((systemChars + userChars) / 4) }
})

const totalChars = rows.reduce((a, r) => a + r.totalChars, 0)
const totalEst = rows.reduce((a, r) => a + r.estTokens, 0)
console.log('PROMPT-SIZE per task (yang DIKIRIM aplikasi kami):')
for (const r of rows) console.log(`  system=${r.systemChars}ch user=${r.userChars}ch total=${r.totalChars}ch ~${r.estTokens} tok | ${r.question}`)
console.log(`\nPROMPT-SIZE rata-rata = ${Math.round(totalChars / rows.length)} char/task ~= ${Math.round(totalEst / rows.length)} token/task (estimasi 4 char/token)`)
console.log('PROMPT-SIZE sistem saja =', JSON.stringify({ chars: SYSTEM_CHAT.length, estTokens: Math.ceil(SYSTEM_CHAT.length / 4) }))

// Amati sisi PROVIDER untuk memisahkan overhead proxy dari prompt kami.
const KEY = readFileSync('/tmp/nine.key', 'utf8').trim()
const probe = async (content: string) => {
  const res = await fetch('http://localhost:20128/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'ag/gemini-3.8-flash-low', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content }] }),
  })
  const text = await res.text()
  const m = text.match(/"prompt_tokens":(\d+)/)
  return m ? Number(m[1]) : null
}
const tiny = await probe('x')
const withSystem = await probe(`${SYSTEM_CHAT}\n\n${QUESTIONS[0]}`)
const sysChars = SYSTEM_CHAT.length + 2 + QUESTIONS[0].length
console.log(`\nPROVIDER overhead probe: prompt 1 char -> ${tiny} prompt_tokens`)
console.log(`PROVIDER overhead probe: system+user (${sysChars} char) -> ${withSystem} prompt_tokens`)
if (tiny !== null && withSystem !== null) {
  // Selisihnya adalah kontribusi prompt kami SEBAGAIMANA DIHITUNG provider.
  console.log(`SELISIH = ${withSystem - tiny} token untuk ${sysChars} char milik kami  ==> ~${(sysChars / (withSystem - tiny)).toFixed(1)} char/token`)
}
await Bun.write('trial/live/prompt-size.json', JSON.stringify({ measuredAt: new Date().toISOString(), rows, avgChars: Math.round(totalChars / rows.length), avgEstTokens: Math.round(totalEst / rows.length), systemChars: SYSTEM_CHAT.length, providerOverheadProbe: { tinyPromptTokens: tiny, withSystemPromptTokens: withSystem } }, null, 2))
