#!/usr/bin/env bun
// ponytail: per-file subprocess runner — Bun's mock.module leaks across files
// in a single invocation (confirmed Bun 1.3.9; see ai.test.ts:5 comment).
// Each test file gets its own bun process for perfect mock isolation.
// Revert to `bun test src/` when Bun fixes mock.module cross-file isolation.

const CONCURRENCY = 8

// ponytail: integration tests need things this runner does not provision —
// connector-dummy wants a live Postgres holding a seeded `dummy_test` schema;
// mcp-install wants network plus a package download. Opt in with
// `bun run test:integration`. Name a file *.integration.test.ts to join them.
const INTEGRATION_FILES = new Set(['src/lib/connector-dummy.test.ts'])
const isIntegration = (f: string) => INTEGRATION_FILES.has(f) || f.endsWith('.integration.test.ts')

// ponytail: unit tests must not depend on a developer's .env. Without this, every
// test touching crypto.ts (notifications, plugin-registry, vector-stores) failed
// with "Missing required env var: ENCRYPTION_SECRET_KEY" on a fresh checkout.
// A real value — .env or CI secret — still wins; this is only a fallback.
const TEST_ENV = {
  ...process.env,
  ENCRYPTION_SECRET_KEY: process.env.ENCRYPTION_SECRET_KEY ?? 'deadbeef'.repeat(8),
}

const runIntegration = process.argv.includes('--integration')
const files: string[] = []
for await (const f of new Bun.Glob('src/**/*.test.ts').scan()) {
  if (isIntegration(f) !== runIntegration) continue
  files.push(f)
}
files.sort()

let totalPass = 0, totalFail = 0, totalSkip = 0, done = 0
const failed: string[] = []
const queue = [...files]

async function worker() {
  while (queue.length) {
    const path = queue.shift()!
    const proc = Bun.spawn(['bun', 'test', path], { stdout: 'pipe', stderr: 'pipe', env: TEST_ENV })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const out = stdout + stderr
    // Read the counts from the SUMMARY LINE only, never from the whole output.
    // `out.match(/(\d+)\s+fail/)` takes the FIRST match anywhere, so a PASSING
    // test whose name contains the pattern poisons the total: the test
    // "exactly 10 runs with 8 failures trips the breaker" prints
    // "(pass) … 8 failures …", which was counted as 8 failing tests while the
    // exit code stayed 0. The runner thus reported "2369 pass · 8 fail" on a
    // fully green suite. A wrong failure count is worse than no count — it
    // trains everyone to ignore the number.
    const summary = out.split('\n').find((l) => /^\s*\d+\s+pass\b/.test(l)) ?? ''
    totalPass += +(summary.match(/(\d+)\s+pass/)?.[1] ?? 0)
    totalFail += +(summary.match(/(\d+)\s+fail/)?.[1] ?? 0)
    totalSkip += +(summary.match(/(\d+)\s+skip/)?.[1] ?? 0)
    done++
    if (code !== 0) {
      failed.push(path)
      console.log(`\nFAIL ${path}`)
      const lines = out.split('\n').filter(Boolean)
      if (lines.length === 0) {
        // A subprocess that dies BEFORE printing anything (OOM kill, a module-load
        // crash) produced no output, so the old report was a bare filename with no
        // explanation -- which is what made three intermittent failures this session
        // look like "flakes" that could not be diagnosed. Say explicitly that there
        // was NO output and report the code, so the two cases are distinguishable:
        // a real test failure always prints a "(fail)" line and a summary.
        console.log(`  (no output — process exited ${code} before printing anything)`)
      } else {
        for (const l of lines.slice(-25)) console.log('  ' + l)
      }
    } else {
      process.stdout.write('.')
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()),
)

console.log(`\n${done}/${files.length} files · ${totalPass} pass · ${totalFail} fail · ${totalSkip} skip`)
if (failed.length) {
  console.log('\nFailed files:')
  for (const f of failed) console.log('  ' + f)
  process.exit(1)
}

export {}
