#!/usr/bin/env bun
/**
 * Repo-wide coverage, measured through the per-file runner.
 *
 * `c8 bun run test` reports 0/0 because scripts/test.ts spawns a subprocess per
 * test file (for mock.module isolation) and c8 only instruments its own process.
 * `bun test src/ --coverage` cannot be used either — the same mock leakage that
 * forces the per-file runner corrupts results.
 *
 * So: run every test file with its own `bun test --coverage`, then merge the
 * lcov reports. Merging is textual: Bun emits lcov, and summing per-file
 * DA:/LF:/LH: records across runs is enough for a line-coverage number.
 */
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const CONCURRENCY = Number(process.env.COVERAGE_CONCURRENCY ?? 8)
const OUT_DIR = '.coverage-merge'

type FileCov = { lines: Map<number, number>; found: number; hit: number }

function parseLcov(text: string, into: Map<string, FileCov>) {
  let current: FileCov | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('SF:')) {
      const path = line.slice(3)
      current = into.get(path) ?? { lines: new Map(), found: 0, hit: 0 }
      into.set(path, current)
    } else if (line.startsWith('DA:') && current) {
      const [num, count] = line.slice(3).split(',')
      const lineNo = Number(num)
      const hits = Number(count)
      // A line counts as covered if ANY run covered it.
      current.lines.set(lineNo, Math.max(current.lines.get(lineNo) ?? 0, hits))
    }
  }
}

async function main() {
  const files: string[] = []
  for await (const f of new Bun.Glob('src/**/*.test.ts').scan()) {
    if (f.endsWith('.integration.test.ts') || f.includes('connector-dummy')) continue
    files.push(f)
  }
  files.sort()

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const env = { ...process.env, ENCRYPTION_SECRET_KEY: process.env.ENCRYPTION_SECRET_KEY ?? 'deadbeef'.repeat(8) }
  const queue = [...files]
  const lcovChunks: string[] = []
  let done = 0
  // Monotonic per-run id. Using `done` as the directory name was wrong: it is
  // incremented after the run, so all N concurrent workers computed the same
  // name and overwrote each other's lcov.
  // Serialises the lcov read+delete across workers.
  let mutexChain: Promise<void> = Promise.resolve()
  const lcovMutex = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = mutexChain.then(fn, fn)
    mutexChain = next.then(() => undefined, () => undefined)
    return next
  }
  const failed: string[] = []

  async function worker() {
    while (queue.length) {
      const path = queue.shift()!
      // Bun writes coverage/lcov.info relative to cwd and renames it into place
      // atomically. Concurrent workers in the SAME cwd clobber each other (the
      // rename lands after another worker already read), which is why the first
      // version of this script measured 0 files. Give each run its own cwd.
      // Keep cwd at the repo root (test files resolve `src/...` and path
      // aliases relatively), and instead serialise the lcov read: Bun renames
      // its report into place atomically, so two workers can still interleave
      // read→delete. A mutex around read+delete is enough and costs nothing
      // measurable next to the test run itself.
      const proc = Bun.spawn(['bun', 'test', path, '--coverage', '--coverage-reporter=lcov'], {
        stdout: 'pipe', stderr: 'pipe', env,
      })
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      if (proc.exitCode !== 0) failed.push(path)
      // Bun always writes to coverage/lcov.info, so concurrent workers would
      // overwrite each other. Read it immediately, then clear it — a subsequent
      // worker can otherwise publish its report after this read and lose it.
      await lcovMutex(async () => {
        const p = join(process.cwd(), 'coverage', 'lcov.info')
        if (existsSync(p)) {
          try { lcovChunks.push(readFileSync(p, 'utf8')) } catch {}
          rmSync(p, { force: true })
        }
      })
      done++
      if (done % 20 === 0) process.stdout.write(`  ${done}/${files.length}\r`)
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  process.stdout.write(`  ${done}/${files.length}\n`)

  const merged = new Map<string, FileCov>()
  for (const chunk of lcovChunks) parseLcov(chunk, merged)

  // Aggregate over src/ only; node_modules and test files excluded so the
  // number means "production code", not "code plus its own tests".
  let totalFound = 0, totalHit = 0
  const rows: Array<{ file: string; hit: number; found: number; pct: number }> = []
  for (const [file, cov] of merged) {
    // Bun emits repo-relative paths ("src/lib/x.ts"), not absolute ones.
    const inSrc = file.startsWith('src/') || file.includes('/src/')
    if (!inSrc || file.includes('.test.')) continue
    let hit = 0
    for (const h of cov.lines.values()) if (h > 0) hit++
    const found = cov.lines.size
    if (found === 0) continue
    totalFound += found
    totalHit += hit
    rows.push({ file, hit, found, pct: (hit / found) * 100 })
  }

  rows.sort((a, b) => a.pct - b.pct)
  console.log('\n=== LINE COVERAGE (src/, tests excluded) ===')
  console.log(`${totalHit}/${totalFound} lines = ${((totalHit / totalFound) * 100).toFixed(2)}%`)
  console.log(`files measured: ${rows.length}`)
  console.log('\nLowest 25 files:')
  for (const r of rows.slice(0, 25)) {
    console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${r.hit}/${r.found}  ${r.file.replace(/.*\/src\//, 'src/')}`)
  }
  const json = {
    linePct: Number(((totalHit / totalFound) * 100).toFixed(2)),
    linesHit: totalHit, linesFound: totalFound, filesMeasured: rows.length,
    failedTestFiles: failed, files: rows,
  }
  writeFileSync('coverage-summary.json', JSON.stringify(json, null, 2))
  console.log(`\nwrote coverage-summary.json (${failed.length} test files failed)`)
  if (failed.length) console.log('FAILED: ' + failed.join(', '))
}
await main()
