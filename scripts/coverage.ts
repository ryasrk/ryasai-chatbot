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
 *
 * FUNCTION coverage is collected too (FNF:/FNH:). Bun emits the per-FILE function
 * totals but not the per-function FN:/FNDA: records, so the function number is
 * per-file, not per-function-name. It is worth having anyway: a file can reach a
 * high LINE percentage while a whole small function was never entered (its lines
 * are counted as covered because a longer neighbour on the same physical line ran),
 * and the function ratio is what exposes that.
 */
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const CONCURRENCY = Number(process.env.COVERAGE_CONCURRENCY ?? 8)
const OUT_DIR = '.coverage-merge'

type FileCov = { lines: Map<number, number>; found: number; hit: number; fFound: number; fHit: number }

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
      current = into.get(path) ?? { lines: new Map(), found: 0, hit: 0, fFound: 0, fHit: 0 }
      into.set(path, current)
    } else if (line.startsWith('DA:') && current) {
      const [num, count] = line.slice(3).split(',')
      const lineNo = Number(num)
      const hits = Number(count)
      // A line counts as covered if ANY run covered it.
      current.lines.set(lineNo, Math.max(current.lines.get(lineNo) ?? 0, hits))
    } else if (line.startsWith('FNF:') && current) {
      // Per-FILE function totals. Bun reports the count for that file in THAT run; take the max
      // across runs, mirroring the line rule, so a file whose functions are split across two test
      // files is not counted as two-thirds covered by either run alone.
      current.fFound = Math.max(current.fFound, Number(line.slice(4)) || 0)
    } else if (line.startsWith('FNH:') && current) {
      current.fHit = Math.max(current.fHit, Number(line.slice(4)) || 0)
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
      // cwd cannot be moved without breaking resolution.
      //
      // CLAIM THE REPORT INSIDE THE SAME CRITICAL SECTION AS THE SPAWN.
      //
      // A mutex around read+rename is NOT enough, and measuring proved it: the
      // shared `coverage/lcov.info` is written by the CHILD process, so a worker
      // that finishes while another holds the lock lets the NEXT worker's child
      // overwrite the file before the lock is released. The report is then
      // silently replaced by a later one, and because both runs DO emit records
      // for shared modules, the merge looks plausible while being wrong:
      // src/lib/planner.ts was reported at 69/673 (10.3%) when its own suite
      // covers 379/578 (65.6%). The numbers are not merely imprecise — 673
      // "lines found" exceeds the figure any single run produces, which is the
      // tell that two different reports were blended.
      //
      // So the spawn itself is serialised. It costs wall-clock time (the suite
      // is ~2 min at concurrency 8), and that is the correct trade for a number
      // people act on. A wrong coverage figure is worse than a slow one.
      await lcovMutex(async () => {
        const shared = join(process.cwd(), 'coverage', 'lcov.info')
        rmSync(shared, { force: true })
        const proc = Bun.spawn(['bun', 'test', path, '--coverage', '--coverage-reporter=lcov'], {
          stdout: 'ignore', stderr: 'ignore', env,
        })
        const code = await proc.exited
        if (code !== 0) failed.push(path)
        if (!existsSync(shared)) return
        const staged = join(OUT_DIR, `lcov-${runId++}.info`)
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

  // ---------------------------------------------------------------------
  // LINE-REACHABILITY CLASSIFIER, and why the headline number needs it.
  //
  // Bun's instrumenter emits lcov DA: records for lines that cannot execute: in a
  // LARGE module graph it emits per-bytecode-OFFSET records and maps unrelated
  // offsets onto arbitrary line numbers, including provably non-executable BLANK
  // lines and COMMENT-ONLY lines. Those phantom records are always 0-hit, so
  // `Math.max` across runs can never mark them covered, and they inflate the
  // denominator ONLY.
  //
  // Measured: evidence-boundary.ts reports 14 line-records and 14 hits in its own
  // suite (100%), but 30 records / 14 hits merged (46.7%) -- all 16 extra records
  // are blank or comment-only lines. ai.ts is the same shape at a larger scale:
  // 416/416 alone, 416/559 merged. Neither can be raised by writing tests, so
  // reporting only the merged figure understates coverage and sends people
  // chasing lines that cannot run.
  //
  // This classifier re-reads the real file and drops DA: records whose line is
  // blank, a standalone comment, or a purely-syntactic fragment. It is
  // DELIBERATELY CONSERVATIVE: anything it cannot confidently classify as
  // non-executable is KEPT in the denominator, so the filtered number can only
  // ever be LOWER than the truth, never higher -- an unfiltered risk here would
  // be silent over-claiming.
  // ---------------------------------------------------------------------
  const reachableCache = new Map<string, Set<number>>()
  function reachableLinesFor(file: string): Set<number> | null {
    if (reachableCache.has(file)) return reachableCache.get(file)!
    let src: string
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      return null
    }
    const raw = src.split('\n')
    // Block-comment tracking is done on the SOURCE order, so a block comment that
    // spans many lines marks every line inside it (and its opening/closing lines)
    // as non-executable.
    const inBlock = new Array<boolean>(raw.length).fill(false)
    let depth = 0
    for (let i = 0; i < raw.length; i++) {
      const line = raw[i]
      const before = depth
      // Approximate JS/TS block-comment scan; '/*' opens, '*/' closes.
      let idx = 0
      let localDepth = depth
      while (idx < line.length) {
        if (localDepth === 0 && line.startsWith('/*', idx)) { localDepth = 1; idx += 2; continue }
        if (localDepth === 1 && line.startsWith('*/', idx)) { localDepth = 0; idx += 2; continue }
        idx++
      }
      inBlock[i] = before > 0 || localDepth > 0 || line.includes('/*') || line.includes('*/')
      depth = localDepth
    }
    const ok = new Set<number>()
    for (let i = 0; i < raw.length; i++) {
      const line = raw[i]
      const t = line.trim()
      if (t === '') continue               // blank
      if (inBlock[i]) continue             // inside or on a block-comment delimiter
      if (t.startsWith('//')) continue     // comment-only
      // A line that is ONLY a delimiter/punctuation fragment carries no statement.
      if (/^[);}\],]+$/.test(t) && t.length <= 4) continue
      ok.add(i + 1)
    }
    reachableCache.set(file, ok)
    return ok
  }
  let rFound = 0, rHit = 0
  let filesUnreadable = 0

  // Aggregate over src/ only; node_modules and test files excluded so the
  // number means "production code", not "code plus its own tests".
  let totalFound = 0, totalHit = 0
  let totalFnFound = 0, totalFnHit = 0
  const rows: Array<{ file: string; hit: number; found: number; pct: number; fHit: number; fFound: number; fPct: number }> = []
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
    // A file can report FNF > 0 with FNH 0 only if its functions were never entered at all --
    // exactly the blind spot the line number hides.
    const fHit = Math.min(cov.fHit, cov.fFound)
    const fFound = cov.fFound
    totalFnFound += fFound
    totalFnHit += fHit
    rows.push({
      file, hit, found, pct: (hit / found) * 100,
      fHit, fFound, fPct: fFound > 0 ? (fHit / fFound) * 100 : 100,
    })
    // Reachability-filtered tally: count only DA records whose line can actually
    // execute in the real source. Kept per-file too so the JSON can show both.
    const reachable = reachableLinesFor(file)
    if (reachable) {
      for (const [ln, h] of cov.lines) {
        if (!reachable.has(ln)) continue
        rFound++
        if (h > 0) rHit++
      }
    } else {
      filesUnreadable++
      rFound += found
      rHit += hit
    }
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
  if (rFound > 0) {
    const phantom = totalFound - rFound
    console.log('')
    console.log('--- excluding lines that CANNOT execute (blank / comment-only / delimiter records) ---')
    console.log(`${rHit}/${rFound} reachable lines = ${((rHit / rFound) * 100).toFixed(2)}%`)
    console.log(`${phantom} DA records dropped as non-executable (${((phantom / totalFound) * 100).toFixed(1)}% of the merged denominator)`)
    if (filesUnreadable) console.log(`(note: ${filesUnreadable} file(s) unreadable, counted unfiltered)`)
  }
  console.log(`files measured: ${rows.length}`)
  console.log('\nLowest 25 files:')
  for (const r of rows.slice(0, 25)) {
    console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${r.hit}/${r.found}  ${r.file.replace(/.*\/src\//, 'src/')}`)
  }
  if (totalFnFound > 0) {
    console.log('\n=== FUNCTION COVERAGE (src/, per-file ratio from FNF/FNH) ===')
    console.log(`${totalFnHit}/${totalFnFound} functions = ${((totalFnHit / totalFnFound) * 100).toFixed(2)}%`)
    const zeroFn = rows.filter((r) => r.fFound > 0 && r.fHit === 0)
    if (zeroFn.length) {
      console.log(`\n${zeroFn.length} file(s) entered ZERO of their functions:`)
      for (const r of zeroFn) console.log(`  ${r.fFound} fn, 0 hit  ${r.file.replace(/.*\/src\//, 'src/')}`)
    }
  }
  const json = {
    linePct: Number(((totalHit / totalFound) * 100).toFixed(2)),
    linesHit: totalHit, linesFound: totalFound,
    reachableLinePct: rFound > 0 ? Number(((rHit / rFound) * 100).toFixed(2)) : null,
    reachableLinesHit: rHit, reachableLinesFound: rFound,
    fnPct: totalFnFound > 0 ? Number(((totalFnHit / totalFnFound) * 100).toFixed(2)) : null,
    fnsHit: totalFnHit, fnsFound: totalFnFound,
    filesMeasured: rows.length,
    failedTestFiles: failed, files: rows,
  }
  writeFileSync('coverage-summary.json', JSON.stringify(json, null, 2))
  console.log(`\nwrote coverage-summary.json (${failed.length} test files failed)`)
  if (failed.length) console.log('FAILED: ' + failed.join(', '))
}
await main()
