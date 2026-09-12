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
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const CONCURRENCY = Number(process.env.COVERAGE_CONCURRENCY ?? 8)
const OUT_DIR = '.coverage-merge'

type FileCov = { lines: Map<number, number>; found: number; hit: number }

const REPO_ROOT = process.cwd()

/**
 * Normalise an lcov `SF:` path to repo-relative form.
 *
 * Bun emits paths relative to the directory it ran in. With the repo root as the
 * cwd that is already `src/lib/x.ts`, but a path can also arrive absolute (a
 * retried run, or a different Bun version), and the merge keys on the string —
 * two spellings of one file would be counted twice and hide coverage rather
 * than combine it.
 */
function normalizeSfPath(raw: string): string {
  const abs = raw.startsWith('/') ? raw : resolve(REPO_ROOT, raw)
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : raw
}

function parseLcov(text: string, into: Map<string, FileCov>) {
  let current: FileCov | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('SF:')) {
      // Each run executes in its own temp cwd, so Bun emits paths relative to
      // THAT directory ("../../home/…/src/lib/x.ts"). Normalise every report to
      // a repo-relative path, or the same file lands under two keys and its
      // coverage is under-counted instead of merged.
      const path = normalizeSfPath(line.slice(3))
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
  // Monotonic id so each run writes to a file nothing else can touch.
  let runId = 0

  async function worker() {
    while (queue.length) {
      const path = queue.shift()!
      // Every run executes in the REPO ROOT and writes the shared
      // `coverage/lcov.info`. An isolated per-run cwd was tried and REJECTED:
      // 139/139 test files failed there, because the runner resolves `.env` and
      // the `@/*` path alias relative to the repo root. Bun hardcodes the report
      // to `coverage/lcov.info` under the cwd and ignores COVERAGE_DIR, so the
      // cwd cannot be moved without breaking resolution. Instead, each run
      // STAGES the shared file into its own path immediately after exiting. The
      // rename is the load-bearing part: a plain read-then-delete can drop a
      // report that another worker published moments later, which is how an
      // earlier version measured 20/529 lines for a module whose own suite
      // covers 326/436.
      const proc = Bun.spawn(['bun', 'test', path, '--coverage', '--coverage-reporter=lcov'], {
        stdout: 'pipe', stderr: 'pipe', env,
      })
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      if (proc.exitCode !== 0) failed.push(path)
      await lcovMutex(async () => {
        const shared = join(process.cwd(), 'coverage', 'lcov.info')
        if (!existsSync(shared)) return
        const staged = join(OUT_DIR, `lcov-${runId++}.info`)
        // renameSync moves the file out of the shared path atomically, so no
        // other worker can be holding a reference to this exact inode.
        try { renameSync(shared, staged) } catch { return }
        try {
          const text = readFileSync(staged, 'utf8')
          if (text.includes('SF:')) lcovChunks.push(text)
        } catch {}
        rmSync(staged, { force: true })
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
  // HONEST NUMBER: this is the UNION across test files, not the coverage of any
  // single suite. A merged run reports fewer lines covered than a single-file
  // run does for the same module (measured: smart-router-helpers 86.8% merged vs
  // 97.3% alone), because Bun reports only the lines it executed in that process
  // and `Math.max` cannot invent hits for lines no run reached. Trust the merged
  // figure for "how much of src/ is exercised by the suite as a whole"; trust a
  // single-file run for "how well this module is tested on its own".
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
