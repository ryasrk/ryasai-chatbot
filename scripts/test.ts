#!/usr/bin/env bun
// ponytail: per-file subprocess runner — Bun's mock.module leaks across files
// in a single invocation (confirmed Bun 1.3.9; see ai.test.ts:5 comment).
// Each test file gets its own bun process for perfect mock isolation.
// Revert to `bun test src/` when Bun fixes mock.module cross-file isolation.

const CONCURRENCY = 8
const files: string[] = []
for await (const f of new Bun.Glob('src/**/*.test.ts').scan()) files.push(f)
files.sort()

let totalPass = 0, totalFail = 0, totalSkip = 0, done = 0
const failed: string[] = []
const queue = [...files]

async function worker() {
  while (queue.length) {
    const path = queue.shift()!
    const proc = Bun.spawn(['bun', 'test', path], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const out = stdout + stderr
    totalPass += +(out.match(/(\d+)\s+pass/)?.[1] ?? 0)
    totalFail += +(out.match(/(\d+)\s+fail/)?.[1] ?? 0)
    totalSkip += +(out.match(/(\d+)\s+skip/)?.[1] ?? 0)
    done++
    if (code !== 0) {
      failed.push(path)
      console.log(`\nFAIL ${path}`)
      for (const l of out.split('\n').filter(Boolean).slice(-25)) console.log('  ' + l)
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
