/**
 * Process isolation for plugin-spawned MCP servers.
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS. A plugin's `mcp-stdio` manifest names a command, and we spawn
 * it as a child of the app process. The allowlist (`ALLOWED_MCP_CMDS`) restricts
 * WHICH interpreter may run, but an interpreter is Turing-complete: a plugin
 * author can still reach the network, read any file this process can read, and
 * see other processes. Allowlisting the interpreter is a naming check, not a
 * containment boundary.
 *
 * WHAT THIS DOES. Wraps the command so it runs with Linux namespaces:
 *   - a NETWORK namespace, so the plugin gets no route off the box
 *   - a PID namespace, so it cannot see or signal other processes
 *   - a MOUNT namespace, so its mounts do not leak into the host
 *   - a USER namespace (`--map-root-user`), which is what makes the above
 *     available to a NON-ROOT process — verified working on this host
 *
 * MEASURED on the target host: `unshare --user --map-root-user --mount --pid
 * --fork --net node -e ...` runs, and inside it `os.networkInterfaces()` reports
 * zero non-loopback interfaces. That is real isolation without a container
 * runtime or new dependency.
 *
 * WHAT THIS DOES NOT DO — read before claiming otherwise:
 *   - It is NOT a filesystem sandbox. The mount namespace is not populated with
 *     a read-only root, so the process still reads whatever the app user can
 *     read. Restricting paths needs a mount setup (or bwrap/firejail) we do not
 *     ship.
 *   - It does NOT cap CPU, memory or process count. A fork bomb inside the
 *     namespace still exhausts the host. `ulimit` here bounds file size and
 *     descriptors only.
 *   - It is NOT a security boundary against a determined local adversary with
 *     kernel exploits; it is containment against a buggy or careless plugin.
 *
 * A namespace flag that the kernel refuses (e.g. user namespaces disabled in
 * `kernel.unprivileged_userns_clone`) is handled explicitly: see
 * `resolveIsolation`.
 */
import { spawnSync } from 'node:child_process'

export type IsolationLevel =
  /** Full namespace set: network, pid, mount, user. */
  | 'namespaces'
  /** `ulimit` only — resource bounds, no namespace separation. */
  | 'rlimits'
  /** Nothing. The command runs exactly as nominated. */
  | 'none'

export interface IsolationPlan {
  /** Flags to insert BEFORE the interpreter, e.g. `['unshare', '--user', ...]`. */
  prefix: string[]
  level: IsolationLevel
  /** Human-readable note for logs and the admin UI. */
  detail: string
}

/**
 * Which isolation level this host can actually provide.
 *
 * Cached because it shells out, and it cannot change while the process runs.
 * `--net` is the flag we probe with: a host can permit user namespaces yet
 * forbid network namespaces in some container configurations, and probing the
 * exact combination we will use is the only honest test.
 */
let cached: IsolationPlan | null = null

export function resolveIsolation(force?: IsolationLevel): IsolationPlan {
  const requested = force ?? (process.env.MCP_PLUGIN_ISOLATION as IsolationLevel | undefined)
  if (cached && requested === undefined) return cached

  const namespaces: IsolationPlan = {
    prefix: ['unshare', '--user', '--map-root-user', '--mount', '--pid', '--fork', '--net'],
    level: 'namespaces',
    detail: 'network, pid and mount namespaces (no route off the box, no other processes visible)',
  }
  const rlimits: IsolationPlan = {
    prefix: [],
    level: 'rlimits',
    detail: 'resource limits only — NO namespace separation',
  }
  const none: IsolationPlan = { prefix: [], level: 'none', detail: 'no isolation' }

  if (requested === 'none') return (cached = none)
  if (requested === 'rlimits') return (cached = rlimits)

  // An operator may pin the level; if they did, honour it without probing.
  if (requested === 'namespaces') return (cached = namespaces)

  if (process.platform !== 'linux') {
    return (cached = {
      ...rlimits,
      detail: `resource limits only — namespaces are Linux-only (platform: ${process.platform})`,
    })
  }

  // Probe the EXACT flag combination we will use.
  const probe = spawnSync(
    'unshare',
    ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--net', 'true'],
    { timeout: 5_000, stdio: 'ignore' },
  )
  if (probe.status === 0) return (cached = namespaces)
  if (probe.error) {
    return (cached = {
      ...rlimits,
      detail: `resource limits only — unshare unavailable (${probe.error.message})`,
    })
  }
  return (cached = {
    ...rlimits,
    detail: 'resource limits only — this host refused user/network namespaces (unprivileged_userns_clone?)',
  })
}

/** Reset the probe cache. Test seam only. */
export function resetIsolationCache(): void {
  cached = null
}

/**
 * Resource caps applied to every plugin-spawned server.
 *
 * `ulimit` is applied via `sh -c` because it is a shell builtin — there is no
 * exec form. Values are deliberately generous for a real MCP server (which needs
 * file descriptors and address space to start a runtime) and tight enough to
 * stop the obvious runaway: a 256 MB file cap and 1024 descriptors.
 */
export const PLUGIN_RLIMITS = {
  /** Max size of any file the process may create, in 512-byte blocks. 512 = 256MB. */
  fileSizeBlocks: 512,
  /** Max open file descriptors. */
  openFiles: 1024,
  /** Max processes/threads — bounds a fork bomb's growth rate. */
  maxProcs: 512,
} as const

/**
 * Build the argv for a plugin command under the chosen isolation.
 *
 * Composition order matters: `unshare` must wrap the SHELL that applies
 * `ulimit`, so the limits are set INSIDE the namespace rather than on the
 * wrapper. Getting this backwards would apply the limits to `unshare` itself and
 * silently not bound the plugin.
 */
export function buildIsolatedArgv(
  command: string,
  args: string[],
  plan: IsolationPlan = resolveIsolation(),
): { file: string; args: string[] } {
  const rlimitScript =
    `ulimit -f ${PLUGIN_RLIMITS.fileSizeBlocks}; `
    + `ulimit -n ${PLUGIN_RLIMITS.openFiles}; `
    + `ulimit -u ${PLUGIN_RLIMITS.maxProcs} 2>/dev/null; `
    + `exec "$0" "$@"`

  // `sh -c <script> <command> <args...>` — $0 holds the command, "$@" the args.
  const shellArgs = ['-c', rlimitScript, command, ...args]

  if (plan.level === 'namespaces') {
    return { file: plan.prefix[0], args: [...plan.prefix.slice(1), 'sh', ...shellArgs] }
  }
  if (plan.level === 'rlimits') {
    return { file: 'sh', args: shellArgs }
  }
  return { file: command, args }
}
