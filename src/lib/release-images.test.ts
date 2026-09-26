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
