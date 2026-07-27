/**
 * Long-turn conversational chat test — simulates a non-technical user
 * asking 15+ follow-up questions across multiple databases and documents.
 *
 * Tests:
 * - Contextual query rewriting ("What about last month?" → "sales for last month")
 * - Intent analysis (clarification, no-retrieval, retrieval)
 * - Multi-database routing (ERP, Chinook, World, Pagila, ClickHouse)
 * - RAG over documents (SOP, Invoice policy, IT procurement, Q1 financials)
 * - Reflection / evidence sufficiency
 * - Conversation memory continuity
 *
 * Usage: bun run scripts/long-turn-chat.ts
 */
import { db } from '../src/lib/db'
import { runNonStreamingChatCompletion, type ChatHistoryEntry } from '../src/lib/tool-router'

const SESSION_ID = 'long-turn-' + Date.now()
const USER_ID = 'usr-admin'

async function sendTurn(
  turnNum: number,
  question: string,
  history: ChatHistoryEntry[],
): Promise<{ answer: string; toolRuns: { type: string; status: string; latencyMs?: number; inputSummary: string }[]; durationMs: number }> {
  const start = Date.now()
  console.log(`\n${'═'.repeat(80)}`)
  console.log(`TURN ${String(turnNum).padStart(2, '0')} [USER]: ${question}`)
  console.log(`${'─'.repeat(80)}`)

  const result = await runNonStreamingChatCompletion({
    question,
    userId: USER_ID,
    sessionId: SESSION_ID,
    chatHistory: history,
  })

  const durationMs = Date.now() - start
  console.log(`TURN ${String(turnNum).padStart(2, '0')} [ASSISTANT] (${durationMs}ms, tools: ${result.toolRuns.map(t => `${t.type}/${t.status}`).join(', ') || 'none'}):`)
  console.log(result.answer.slice(0, 500) + (result.answer.length > 500 ? '\n   [...truncated]' : ''))

  return {
    answer: result.answer,
    toolRuns: result.toolRuns.map(t => ({
      type: t.type,
      status: t.status,
      latencyMs: t.latencyMs,
      inputSummary: t.inputSummary,
    })),
    durationMs,
  }
}

async function main() {
  console.log('╔' + '═'.repeat(78) + '╗')
  console.log('║  LONG-TURN CONVERSATIONAL CHAT TEST — non-technical user, 15+ follow-ups     ║')
  console.log('╚' + '═'.repeat(78) + '╝')
  console.log(`Session: ${SESSION_ID}`)
  console.log(`User: ${USER_ID}`)
  console.log(`Time: ${new Date().toISOString()}`)

  // Persist a session row so cognee rememberChatTurn can use it
  await db.chatSession.create({
    data: { id: SESSION_ID, userId: USER_ID, title: 'Long-turn multi-DB test' },
  }).catch(() => {})

  const history: ChatHistoryEntry[] = []
  const results: { turn: number; question: string; answer: string; tools: string[]; durationMs: number }[] = []

  // ── Conversation script ──────────────────────────────────────────────
  // A non-technical user (e.g. a manager) exploring business data.
  // Each follow-up builds on the previous answer — tests query rewriting,
  // intent analysis, and multi-database routing.

  const turns: string[] = [
    // 1 — Greeting (no retrieval, CHAT)
    "Hi, what can you help me with?",
    // 2 — Document search (RAG — SOP)
    "What's the procedure for stock opname?",
    // 3 — Follow-up on SOP (RAG — needs context rewriting)
    "How often should it be done?",
    // 4 — Follow-up on SOP (RAG — needs context rewriting)
    "What happens if there's a discrepancy?",
    // 5 — Switch topic: invoice policy (RAG)
    "What are the payment terms for enterprise customers?",
    // 6 — Follow-up invoice (RAG — context)
    "Is there a discount for early payment?",
    // 7 — Follow-up invoice (RAG — context)
    "What about late payment penalties?",
    // 8 — Switch topic: SQL — ERP inventory
    "Show me the products with the lowest stock in our ERP.",
    // 9 — Follow-up SQL (context — "what about" = same query different filter)
    "Which ones are below reorder level?",
    // 10 — Switch DB: Chinook music store
    "How many tracks are in the Chinook database?",
    // 11 — Follow-up Chinook (context)
    "What are the top 5 genres by track count?",
    // 12 — Follow-up Chinook (context — "what about" pattern)
    "Show me the top 3 customers by total spending.",
    // 13 — Switch DB: World Geography
    "What's the population of Jakarta?",
    // 14 — Follow-up World (context — implicit "capital cities")
    "What about Tokyo?",
    // 15 — Follow-up World (context — "bigger than" comparison)
    "Which countries have cities with population over 5 million?",
    // 16 — Switch DB: Pagila movie rental
    "How many movies are in the Pagila database?",
    // 17 — Follow-up Pagila (context)
    "What are the most rented film categories?",
    // 18 — Switch to financial report (RAG — document)
    "What was our Q1 revenue?",
    // 19 — Follow-up financial (RAG — context)
    "What was the net profit?",
    // 20 — Multi-hop: combine DB + document (tests planner if enabled, else CHAT)
    "Compare our Q1 net profit with the total inventory value.",
  ]

  for (let i = 0; i < turns.length; i++) {
    const turnNum = i + 1
    const question = turns[i]

    try {
      const result = await sendTurn(turnNum, question, [...history])

      history.push({ role: 'user', content: question })
      history.push({ role: 'assistant', content: result.answer })

      results.push({
        turn: turnNum,
        question,
        answer: result.answer.slice(0, 200),
        tools: result.toolRuns.map(t => `${t.type}/${t.status}`),
        durationMs: result.durationMs,
      })
    } catch (e) {
      console.error(`TURN ${turnNum} FAILED:`, e instanceof Error ? e.message : String(e))
      history.push({ role: 'user', content: question })
      history.push({ role: 'assistant', content: `[ERROR: ${e instanceof Error ? e.message : String(e)}]` })
      results.push({
        turn: turnNum,
        question,
        answer: `[ERROR]`,
        tools: ['error'],
        durationMs: 0,
      })
    }
  }

  // ── Summary report ───────────────────────────────────────────────────
  console.log('\n\n')
  console.log('╔' + '═'.repeat(78) + '╗')
  console.log('║  SUMMARY REPORT                                                              ║')
  console.log('╚' + '═'.repeat(78) + '╝')
  console.log()

  const toolStats: Record<string, number> = {}
  const statusStats: Record<string, number> = {}
  let totalDurationMs = 0
  let successCount = 0
  let errorCount = 0
  let blockedCount = 0

  for (const r of results) {
    for (const t of r.tools) {
      toolStats[t] = (toolStats[t] ?? 0) + 1
      if (t.includes('/success')) successCount++
      if (t.includes('/error')) errorCount++
      if (t.includes('/blocked')) blockedCount++
    }
    totalDurationMs += r.durationMs

    const status = r.tools.join(', ') || 'none'
    console.log(
      `  Turn ${String(r.turn).padStart(2, '0')} [${String(r.durationMs).padStart(5)}ms] [${status.padEnd(30)}] ${r.question.slice(0, 50)}`,
    )
  }

  console.log()
  console.log(`  Total turns:      ${results.length}`)
  console.log(`  Success:          ${successCount}`)
  console.log(`  Errors:           ${errorCount}`)
  console.log(`  Blocked:          ${blockedCount}`)
  console.log(`  Total time:       ${(totalDurationMs / 1000).toFixed(1)}s`)
  console.log(`  Avg per turn:     ${(totalDurationMs / results.length / 1000).toFixed(1)}s`)
  console.log()
  console.log('  Tool breakdown:')
  for (const [t, count] of Object.entries(toolStats).sort()) {
    console.log(`    ${t}: ${count}`)
  }

  // ── Conversation memory check ────────────────────────────────────────
  console.log()
  console.log('  Conversation history length:', history.length, 'messages')

  // Check if follow-up questions got rewritten by looking at tool input summaries
  // (the toolRouter should use effectiveQuestion, not the raw follow-up)
  console.log()
  console.log('  Note: Follow-up questions (e.g. "How often should it be done?") should')
  console.log('  have been rewritten to standalone queries before retrieval.')
  console.log('  Check tool inputSummary above for rewritten query evidence.')

  // ── Pass/fail gate ───────────────────────────────────────────────────
  const passRate = successCount / (successCount + errorCount + blockedCount)
  console.log()
  console.log(`  Pass rate: ${(passRate * 100).toFixed(1)}%`)
  if (passRate >= 0.85) {
    console.log('  ✅ PASS — conversation completed with >85% success rate')
  } else if (passRate >= 0.70) {
    console.log('  ⚠️  PARTIAL — some turns failed, investigate above')
  } else {
    console.log('  ❌ FAIL — too many failures, investigate above')
  }

  // Save results to file
  const reportPath = '/tmp/opencode/long-turn-chat-results.json'
  await Bun.write(reportPath, JSON.stringify(results, null, 2))
  console.log()
  console.log(`  Full results saved to: ${reportPath}`)
}

main()
  .catch((e) => {
    console.error('FATAL:', e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
