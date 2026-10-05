import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every FACTUAL claim in the public README, checked against the tree.
 *
 * WHY THIS EXISTS: a README that invents facts is worse than a technical one, because a reader cannot tell which
 * lines to trust once they find one that is wrong. MEASURED on the version this replaced: the badge said 1.0.0 while
 * the release was 1.2.0, and a capability table gave the bundled embedding model as "dim 1536" when that model is
 * 384-dimensional — the same number this product's schema stores, so the README contradicted the code in the one
 * place a reader was least able to check.
 *
 * The assertions are deliberately about claims a READER COULD CHECK THEMSELVES (a version badge, a flag that exists,
 * a file that resolves). Anything that cannot be checked from the repository is not stated as fact in the README —
 * answer quality is the notable one, and there is an assertion that it stays unclaimed.
 */
const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const readme = read('README.md')
const pkg = JSON.parse(read('package.json')) as { version: string; scripts: Record<string, string> }

describe('README claims — each one checkable from the repository', () => {
  test('the version badge matches package.json', () => {
    // A badge is the first thing a reader sees and the cheapest claim to get wrong.
    expect(readme).toContain(`version-${pkg.version}-blue`)
  })

  test('every linked document exists', () => {
    // A reference section whose links 404 is worse than no reference section.
    const links = [...readme.matchAll(/\]\(\.\/([^)#]+)\)/g)].map((m) => m[1]!)
    const missing = links.filter((l) => !existsSync(join(ROOT, l)))
    expect(missing).toEqual([])
  })

  test('every referenced command exists in package.json', () => {
    const referenced = ['dev', 'test', 'e2e', 'e2e:prod', 'lint']
    const missing = referenced.filter((s) => !pkg.scripts[s])
    expect(missing).toEqual([])
  })

  test('the installer flags the README documents are the ones install.sh accepts', () => {
    const install = read('install.sh')
    for (const flag of ['--port', '--dir', '--with-searxng']) {
      expect(install).toContain(flag)
    }
    // And the documented default port is the one the script uses. `DEFAULT_APP_PORT`, not `DEFAULT_PORT`.
    expect(install).toMatch(/DEFAULT_APP_PORT=38180/)
    expect(readme).toContain('38180')
  })

  test('the database engines and providers listed are the ones implemented', () => {
    const connectors = read('src/lib/connectors.ts')
    for (const engine of ['POSTGRESQL', 'MYSQL', 'MSSQL', 'CLICKHOUSE']) {
      expect(connectors).toContain(engine)
    }
    const presets = read('src/lib/db-provider-presets.ts')
    for (const provider of ['SUPABASE', 'NEON', 'PLANETSCALE', 'TIDB', 'COCKROACHDB']) {
      expect(presets).toContain(`'${provider}'`)
    }
  })

  test('test totals are obtained from the official runner', () => {
    // Fixed totals drift as files are added. The old assertion required a stale round number.
    expect(readme).toContain('Use `bun run test`')
    expect(readme).toContain('current executed file and test totals')
    expect(readme).toContain('bun run test:integration')
    expect(readme).not.toMatch(/around \d+ test files|[\d,]+\+ individual tests/)
    expect(pkg.scripts.test).toBe('bun scripts/test.ts')
  })

  test('answer quality is NOT claimed as a number', () => {
    /*
     * Quality depends on the customer's data and their model provider, and the numbers this repository CAN produce
     * were measured on a mock stack. Stating one would be the most persuasive false claim in the file, so the README
     * points at the harnesses and says to run them on your own corpus instead.
     */
    expect(readme).not.toMatch(/\b(RAGAS\s*[:=]|accuracy\s+of\s+\d+\s*%|precision\s+of\s+\d+\s*%)/i)
    // The exact phrase the README uses to point at the harnesses. Matching the INTENT rather than one tense: the
    // first version of this line required "measured on your own corpus" while the file says "measure it on your own
    // corpus", so it failed on a wording difference and would have been "fixed" by editing the README instead.
    expect(readme).toMatch(/measur\w* it on your own corpus/i)
  })

  test('the deployment description discloses configured AI and licence requests', () => {
    // BYOK can target a hosted provider. The old assertion pinned a false no-egress promise.
    expect(readme).not.toMatch(/nothing is sent to a vendor cloud/i)
    expect(readme).toContain('using a hosted provider sends the relevant prompts and evidence to that provider')
    expect(readme).toContain('contacts our central License Validator')
    expect(readme).toContain('non-empty key value')
    const client = read('src/lib/llm-client.ts')
    expect(client).toContain('cfg.apiKey')
    expect(client).toContain('${cfg.baseUrl}/chat/completions')
    expect(read('src/lib/license-client.ts')).toContain('/api/v1/license/validate')
  })
})
