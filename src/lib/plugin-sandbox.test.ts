import { describe, test, expect, beforeEach } from 'bun:test'
import {
  resolveIsolation, buildIsolatedArgv, resetIsolationCache, PLUGIN_RLIMITS,
} from './plugin-sandbox'

/**
 * The isolation level depends on the HOST (kernel, unprivileged_userns_clone,
 * container config), so the level itself is asserted as "one of the valid
 * levels" and the REQUIRED behaviour is asserted per level. Asserting
 * `namespaces` outright would fail on a host that legitimately cannot provide
 * it — and the degradation is a supported outcome, not an error.
 */
describe('plugin-sandbox — isolation planning', () => {
  beforeEach(() => resetIsolationCache())

  test('the resolved level is one of the three supported levels', () => {
    expect(['namespaces', 'rlimits', 'none']).toContain(resolveIsolation().level)
  })

  test('the plan always explains itself', () => {
    // A silently-degraded sandbox is the failure mode that matters: an operator
    // must be able to read WHY plugins are not network-isolated here.
    expect(resolveIsolation().detail.length).toBeGreaterThan(0)
  })

  test('an operator pin is honoured without probing the host', () => {
    expect(resolveIsolation('none').level).toBe('none')
    expect(resolveIsolation('rlimits').level).toBe('rlimits')
    expect(resolveIsolation('namespaces').prefix).toContain('unshare')
  })
})

describe('plugin-sandbox — argv composition', () => {
  beforeEach(() => resetIsolationCache())

  test('under namespaces, the command is wrapped and rlimits sit INSIDE', () => {
    const argv = buildIsolatedArgv('node', ['/p.mjs', '--x'], resolveIsolation('namespaces'))
    expect(argv.file).toBe('unshare')
    expect(argv.args).toContain('--net')
    expect(argv.args).toContain('--pid')
    expect(argv.args).toContain('--mount')
    expect(argv.args).toContain('--user')

    // Locate the script by content: its index is not fixed, and hardcoding one
    // is exactly how the first version of this check failed while the code was
    // already correct.
    const i = argv.args.findIndex((a) => a.includes('ulimit'))
    expect(i).toBeGreaterThan(-1)
    const script = argv.args[i]
    expect(script).toContain(`ulimit -f ${PLUGIN_RLIMITS.fileSizeBlocks}`)
    expect(script).toContain(`ulimit -n ${PLUGIN_RLIMITS.openFiles}`)
    // The limits must apply to the PLUGIN, not to the unshare wrapper.
    expect(script).toContain('exec "$0" "$@"')
    expect(argv.args[i + 1]).toBe('node')
    expect(argv.args[i + 2]).toBe('/p.mjs')
    expect(argv.args[i + 3]).toBe('--x')
  })

  test('under rlimits, caps still apply but nothing is namespaced', () => {
    const argv = buildIsolatedArgv('node', ['/p.mjs'], resolveIsolation('rlimits'))
    expect(argv.file).toBe('sh')
    expect(argv.args[1]).toContain('ulimit -f')
    expect(argv.args.join(' ')).not.toContain('--net')
  })

  test('under none, the command is passed through untouched', () => {
    const argv = buildIsolatedArgv('node', ['/p.mjs'], resolveIsolation('none'))
    expect(argv.file).toBe('node')
    expect(argv.args).toEqual(['/p.mjs'])
  })

  test('an argument containing shell metacharacters is NOT re-interpreted', () => {
    // The plugin's args arrive as argv, never through a shell — the `sh -c`
    // script reads them via "$@" so a `; rm -rf` in an argument stays data.
    const nasty = 'a; rm -rf /'
    const argv = buildIsolatedArgv('node', ['/p.mjs', nasty], resolveIsolation('namespaces'))
    const i = argv.args.findIndex((a) => a.includes('ulimit'))
    // The dangerous string must be its own argv element, not concatenated in.
    expect(argv.args[i + 3]).toBe(nasty)
    expect(argv.args[i]).not.toContain(nasty)
  })
})
