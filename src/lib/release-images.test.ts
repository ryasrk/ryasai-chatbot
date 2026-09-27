import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The release invariant a customer install depends on: every image tag that `install.sh` writes
 * into the compose file must also be BUILT by `.github/workflows/build-images.yml`.
 *
 * WHY THIS EXISTS. Those two lists can drift, and the drift is invisible until someone installs:
 * the `:embeddings` build step was added on 2026-09-24 18:42 while the last workflow run was
 * 2026-09-24 02:43, sixteen hours earlier. `install.sh` pulls
 * `ghcr.io/ryasrk/ryasai-chatbot:embeddings`, the tag did not exist, and a fresh
 * `curl … | bash` failed at `docker compose pull` with
 *
 *     failed to resolve reference "…:embeddings": not found
 *
 * and no build fallback — so the product could not be installed AT ALL. Every other referenced
 * image resolved; only the unbuilt one was missing. Reproduced through the installer's own
 * generated compose, not inferred.
 *
 * WHAT THIS GUARD CAN AND CANNOT SEE. It reads two files, so it catches the static half: a tag
 * referenced by the installer but never defined as a build target. It CANNOT see whether the tag
 * actually exists in the registry — that needs the network, and a test that reaches GHCR would be
 * flaky and would fail in CI without credentials. The runtime half is covered by the release
 * checklist in AGENTS.md. Being explicit about the limit matters: a guard that looks like it
 * proves more than it does is the failure mode this repo already catalogues.
 */
describe('release: every image the installer pulls is built by CI', () => {
  const root = join(import.meta.dir, '..', '..')
  const installSh = readFileSync(join(root, 'install.sh'), 'utf-8')
  const workflow = readFileSync(
    join(root, '.github', 'workflows', 'build-images.yml'),
    'utf-8',
  )

  /** Our own registry namespace only — third-party images are not ours to build. */
  const OUR_REGISTRY = /ghcr\.io\/ryasrk\/ryasai-chatbot:([a-z0-9][a-z0-9._-]*)/g

  /**
   * Strip YAML comments before matching, and that step is LOAD-BEARING.
   *
   * The first version of this guard did not, and it was VACUOUS: its negative control — renaming
   * the build tag to `:embeddings-disabled` — still passed, because the workflow's own explanatory
   * COMMENT mentions `ghcr.io/ryasrk/ryasai-chatbot:embeddings`, so the "built" set contained a
   * match for a tag that is no longer built anywhere. That is the repo's own class 1 (a guard
   * matching a WORD rather than a CALL) reproduced while writing the guard against a different
   * class. A comment is not a build step.
   */
  const stripYamlComments = (src: string) =>
    src
      .split('\n')
      .map((line) => {
        const hash = line.indexOf('#')
        return hash === -1 ? line : line.slice(0, hash)
      })
      .join('\n')

  const referenced = [...new Set([...installSh.matchAll(OUR_REGISTRY)].map((m) => m[1]))].sort()
  const built = [
    ...new Set([...stripYamlComments(workflow).matchAll(OUR_REGISTRY)].map((m) => m[1])),
  ].sort()

  test('the installer references at least one of our images', () => {
    // A negative control on the extraction itself: if the regex or the file layout changes such
    // that nothing is found, the set comparison below would pass vacuously ([] ⊆ []).
    expect(referenced.length).toBeGreaterThan(0)
    expect(built.length).toBeGreaterThan(0)
  })

  test('no referenced image is missing from the build workflow', () => {
    const unbuilt = referenced.filter((tag) => !built.includes(tag))
    expect(
      unbuilt,
      `install.sh pulls ${unbuilt.join(', ')} but build-images.yml never builds it — a fresh ` +
        `install would fail at "docker compose pull" with "not found". Add the build step, then ` +
        `publish it (push to main, a v*.*.* tag, or workflow_dispatch) before shipping.`,
    ).toEqual([])
  })

  test('the workflow can be run on demand, not only on push', () => {
    // The drift above could not be repaired without a code push while the trigger was push-only.
    // A manual trigger is what makes "the build step exists" recoverable into "the tag is reachable".
    expect(workflow).toContain('workflow_dispatch')
  })
})

describe('installer: a failed database backup must not be reported as saved', () => {
  /**
   * INCIDENT (2026-09-27), found on a live host while deploying.
   *
   * The pre-update backup was:
   *
   *     pg_dump ... > "$BACKUP_DIR/ryasai-$STAMP.sql"
   *
   * and the shell CREATES a redirect target BEFORE running the command. When `pg_dump` failed, a
   * 0-byte file was left behind and the `if` reported success for the redirect — so the installer
   * printed "DB backup saved" for a file containing nothing. Observed: `ryasai-20260927-051118.sql`
   * was 0 bytes while the installer had called it a backup.
   *
   * WHY THIS IS WORSE THAN NO BACKUP: it is the artifact an operator reaches for during an incident.
   * They would restore nothing, and believe they had a restore point.
   */
  // Local root: the describe above declares its own inside its scope, so referencing that one
  // would throw at collection time and silently drop every test in this block.
  const here = join(import.meta.dir, '..', '..')
  const installShRaw = readFileSync(join(here, 'install.sh'), 'utf-8')

  /**
   * Strip shell comments. LOAD-BEARING: the fix's own explanatory comment QUOTES the fatal pattern
   * (`pg_dump > "$BACKUP_DIR/..."`), so a raw scan reports the very line it documents. This is the
   * same trap the release-image guard hit with YAML comments, and it is the reason every guard here
   * is negative-controlled.
   */
  const installSh = installShRaw
    .split('\n')
    .map((l) => {
      const t = l.trimStart()
      return t.startsWith('#') ? '' : l
    })
    .join('\n')

  test('the dump goes to a temp file and is moved into place only when non-empty', () => {
    expect(installSh).toContain('BACKUP_TMP=')
    // `-s` is the load-bearing test: a guard that only checked exit status would still accept a
    // truncated dump on a pipe failure.
    expect(installSh).toMatch(/\[ -s "\$BACKUP_TMP" \]/)
    expect(installSh).toMatch(/mv "\$BACKUP_TMP" "\$BACKUP_DIR\/ryasai-\$STAMP\.sql"/)
  })

  test('the old redirect-into-the-final-path form is gone', () => {
    // Not merely "TEMP exists" — the fatal pattern itself must be absent, or a future edit could
    // reintroduce it alongside the temp file and nothing would fail.
    expect(installSh).not.toMatch(/> "\$BACKUP_DIR\/ryasai-\$STAMP\.sql"/)
  })

  test('a failure is reported, not swallowed', () => {
    expect(installSh).toMatch(/DB backup FAILED/)
    expect(installSh).toMatch(/NO restore point/)
  })

  test('stale 0-byte dumps from earlier releases are cleaned up', () => {
    // They are indistinguishable from a real backup by name, so they must not survive to be picked
    // from the rotation during an incident.
    expect(installSh).toMatch(/-name 'ryasai-\*\.sql' -size 0 -delete/)
  })
})

describe('installer: the cognee healthcheck window must exceed its measured boot time', () => {
  /**
   * MEASURED on the production host: the cognee sidecar's server does not listen until its boot work
   * is done — ~125s with `OPENAI_API_BASE` set, longer when the three `LLM_*` vars are also filled
   * (cognee validates them at startup).
   *
   * The original `start_period: 90s` + `interval: 30s` × `retries: 3` gave a ~180s budget, and the
   * container was observed flapping to `unhealthy` on a boot that finished shortly after. A healthy
   * sidecar reported as broken is the failure this guards: it is the operator's first impression of
   * memory, and it sends them debugging a container that is fine.
   *
   * SCOPED TO THE COGNEE BLOCK. `install.sh` defines THREE healthchecks (app, a first-boot-downloads
   * service, cognee) with different windows; my first version of this guard regexed the whole file and
   * matched the app's 60s, failing while the cognee value was already correct. A file-wide number
   * match measures whichever service happens to come first.
   */
  const installRaw = readFileSync(join(import.meta.dir, '..', '..', 'install.sh'), 'utf-8')

  /**
   * The cognee service block: from `  cognee:` to the next service at the same indent, WITH COMMENTS
   * STRIPPED.
   *
   * The comment stripping is load-bearing and was added after this guard failed on itself: the note
   * above the value quotes the OLD setting ("The previous `start_period: 90s` ..."), and a regex over
   * the raw block matched that PROSE instead of `start_period: 180s` nine lines below. Matching a
   * number that appears in an explanation of the number is this repo's most repeated defect, and it
   * is why every guard here runs against comment-stripped source.
   */
  function cogneeBlock(): string {
    const start = installRaw.search(/^\s{2}cognee:\s*$/m)
    expect(start).toBeGreaterThan(-1)
    const rest = installRaw.slice(start)
    const end = rest.slice(1).search(/^\s{2}[a-z][a-z0-9_-]*:\s*$/m)
    const block = end === -1 ? rest : rest.slice(0, end + 1)
    return block
      .split('\n')
      .map((l) => (l.trimStart().startsWith('#') ? '' : l))
      .join('\n')
  }

  test('the start_period exceeds the measured 125s boot', () => {
    // Assert on the NUMBER, not on the presence of a key: a smaller value would satisfy a mere
    // `toContain('start_period')` while reintroducing the flap.
    const m = cogneeBlock().match(/start_period:\s*(\d+)s/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThanOrEqual(180)
  })

  test('the total budget (start_period + interval × retries) leaves real margin', () => {
    // start_period is a grace window; the retries that follow are what actually mark it unhealthy, so
    // the guard checks the SUM rather than one field.
    const block = cogneeBlock()
    const sp = Number(block.match(/start_period:\s*(\d+)s/)![1])
    const interval = Number(block.match(/interval:\s*(\d+)s/)?.[1] ?? 0)
    const retries = Number(block.match(/retries:\s*(\d+)/)?.[1] ?? 0)
    expect(sp + interval * retries).toBeGreaterThanOrEqual(300)
  })
})

describe('test harness: the runner and the coverage script must collect .tsx tests', () => {
  /**
   * MEASURED GAP: both scripts globbed only dot-test-dot-ts, which does NOT match the .tsx variant. So a component
   * test could neither RUN (`scripts/test.ts`) nor appear in the coverage report as a file whose coverage
   * was never measured (`scripts/coverage.ts`).
   *
   * `src/components/views/cognee-diagnostics-render.test.tsx` was in exactly that state — written, present
   * in the tree, and executed by nothing. A test that never runs is worse than no test: it looks like
   * coverage of a surface nothing actually checks, and its assertions can rot silently.
   *
   * Two narrow globs in two scripts is why this is guarded at the PATTERN rather than by renaming the file:
   * the same shape had already occurred once in this loop for `benchmark/`, and renaming one file leaves
   * the next `.tsx` to fail identically.
   */
  const repoRoot = join(import.meta.dir, '..', '..')

  test('the runner collects both extensions', () => {
    const runner = readFileSync(join(repoRoot, 'scripts', 'test.ts'), 'utf-8')
    expect(runner).toContain('*.test.{ts,tsx}')
  })

  test('the coverage script collects both extensions', () => {
    const cov = readFileSync(join(repoRoot, 'scripts', 'coverage.ts'), 'utf-8')
    expect(cov).toContain('*.test.{ts,tsx}')
  })

  test('the glob actually matches a real .tsx test on disk', async () => {
    // Behavioural, not textual: the pattern must FIND the file, so a future glob that looks right but
    // resolves wrong still fails here.
    const glob = new Bun.Glob('{src,benchmark}/**/*.test.{ts,tsx}')
    const found: string[] = []
    for await (const f of glob.scan()) found.push(f)
    const tsx = found.filter((f) => f.endsWith('.tsx'))
    expect(tsx.length).toBeGreaterThan(0)
    expect(tsx.some((f) => f.includes('cognee-diagnostics-render'))).toBe(true)
  })
})
