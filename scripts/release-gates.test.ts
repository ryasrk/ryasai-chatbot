import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

type Workflow = { on: Record<string, unknown>; jobs: Record<string, { uses?: string; needs?: string[]; if?: string; secrets?: string }> }
function workflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as Workflow
}
describe('release verification ordering', () => {
  test('publishing depends on application CI and a release-only live evaluation', () => {
    const jobs = workflow('build-images').jobs
    expect(jobs['quality-checks'].uses).toBe('./.github/workflows/ci.yml')
    expect(jobs['live-quality'].uses).toBe('./.github/workflows/eval.yml')
    expect(jobs['live-quality'].if).toBe("startsWith(github.ref, 'refs/tags/v')")
    expect(jobs['live-quality'].secrets).toBe('inherit')
    expect(jobs['build-push'].needs).toEqual(['quality-checks', 'live-quality'])
    expect(jobs['build-push'].if).toContain("needs.quality-checks.result == 'success'")
    expect(jobs['build-push'].if).toContain("needs.live-quality.result == 'success'")
    expect(jobs['build-push'].if).toContain("needs.live-quality.result == 'skipped'")
  })
  test('verification workflows can be called by the publisher', () => {
    for (const name of ['ci', 'eval']) expect(Object.hasOwn(workflow(name).on, 'workflow_call')).toBe(true)
  })
})
