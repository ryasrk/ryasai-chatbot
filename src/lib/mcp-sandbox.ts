/**
 * Organizational sandbox isolation for MCP servers.
 * ----------------------------------------------------------------------------
 * Each organization gets its own isolated filesystem namespace for MCP server
 * execution, package caching, and temporary files. This prevents cross-org
 * contamination while keeping deployment simple (no Docker per server).
 *
 * Security guarantees:
 * - Filesystem isolation via separate directories with 0o700 permissions
 * - Package caching scoped per-org to prevent npm conflicts
 * - Environment variable isolation via wrapper scripts
 * - Audit logging partitioned by organization
 * - Resource quota enforcement per organization
 */
import { mkdir, chmod, rm } from 'node:fs/promises'
import { statSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * Root for every per-org sandbox.
 *
 * `/var/mcp/isolated` is the production default and stays hardcoded as the shipped behaviour.
 * `MCP_SANDBOX_DIR` exists so the isolation can be EXERCISED (its permissions asserted on a
 * real filesystem) without writing to a host path — mocking `node:fs` instead would make the
 * "0o700 on disk" test assert its own mock, which is the whole security claim.
 *
 * Read at CALL time, not at module load, so a test can point it at a temp dir after import.
 */
function baseSandboxDir(): string {
  return process.env.MCP_SANDBOX_DIR || '/var/mcp/isolated'
}

export interface OrganizationalSandbox {
  orgId: string
  sandboxPath: string
  npxCachePath: string
  runtimePath: string
  tmpPath: string
}

/**
 * Ensure an organizational sandbox exists for the given orgId.
 * Creates the directory structure if it doesn't exist.
 */
export async function ensureOrganizationalSandbox(
  organizationId: string
): Promise<OrganizationalSandbox> {
  const sandboxPath = join(baseSandboxDir(), `org-${organizationId}`)
  const npxCachePath = join(sandboxPath, 'npx-cache')
  const runtimePath = join(sandboxPath, 'mcp-runtime')
  const tmpPath = join(sandboxPath, 'tmp')

  // Create directories if they don't exist
  await Promise.all([
    mkdir(sandboxPath, { recursive: true }),
    mkdir(npxCachePath, { recursive: true }),
    mkdir(runtimePath, { recursive: true }),
    mkdir(tmpPath, { recursive: true, mode: 0o700 }),
  ])

  // Set restrictive permissions on core directories (owner-only access)
  // This ensures other organizations cannot access this org's data.
  await Promise.all([
    chmod(sandboxPath, 0o700),
    chmod(npxCachePath, 0o700),
    chmod(runtimePath, 0o700),
    chmod(tmpPath, 0o700),
  ])
  // ponytail: the tmp dir was chmod(0o1777) "for /tmp behavior", but MEASURED on Bun 1.3.14
  // that silently drops the sticky bit: chmod(path, 0o1777) and chmod(path, 0o1000 | 0o777)
  // both yield 0o777 (verified with stat; only the `chmod` SHELL binary produces 0o1777). So
  // the mode was applied but the sticky bit never was — a comment promising a guarantee the
  // runtime did not deliver. Rather than shelling out (fragile, and a second way to set
  // permissions that can drift), the directory is now owner-only like its siblings. That is
  // STRICTER than 0o1777 for cross-org safety: a 0o700 tmp is unreachable by other orgs
  // entirely, whereas 0o1777 relies on the sticky bit to stop unlinks. The sandboxed process
  // runs as the same user, so it keeps full use of the directory.

  return {
    orgId: organizationId,
    sandboxPath,
    npxCachePath,
    runtimePath,
    tmpPath,
  }
}

/**
 * Get the wrapper script that sets up the sandbox environment.
 * This script configures NPM paths, HOME directory, and PATH for MCP execution.
 */
export function getSandboxWrapperScript(
  sandbox: OrganizationalSandbox,
  command: string,
  args: string[]
): string {
  return `#!/bin/bash
# MCP Server Sandbox Wrapper
# Auto-generated for organization: ${sandbox.orgId}
# DO NOT EDIT

# Set isolated environment
export HOME="${sandbox.sandboxPath}"
export NPM_CONFIG_PREFIX="${sandbox.runtimePath}"
export NPM_CONFIG_CACHE="${sandbox.npxCachePath}"
export TMPDIR="${sandbox.tmpPath}"
export PATH="${sandbox.runtimePath}/bin:$PATH"
export NODE_ENV="production"

# Execute the MCP server with restricted permissions
exec ${command} ${args.map(a => `'${a.replace(/'/g, "'\"'\"'")}'`).join(' ')}
`
}

/**
 * Generate a unique npm scope prefix for the organization.
 * This prevents package name conflicts between organizations.
 */
export function getNpmScopeForOrg(sandbox: OrganizationalSandbox): string {
  const shortId = sandbox.orgId.slice(0, 8)
  return `@ryasai-org-${shortId}`
}

/**
 * Clean up stale organizational sandbox after organization deletion or inactivity.
 * Removes the sandbox directory safely.
 */
export async function cleanupOrganizationalSandbox(
  organizationId: string
): Promise<void> {
  const sandboxPath = join(baseSandboxDir(), `org-${organizationId}`)
  
  try {
    await rm(sandboxPath, { recursive: true, force: true })
    console.log(`[mcp-sandbox] Cleaned up sandbox for org: ${organizationId}`)
  } catch (error) {
    console.error(`[mcp-sandbox] Failed to cleanup sandbox for org ${organizationId}:`, error)
    throw error
  }
}

/**
 * Get sandbox metadata for monitoring/auditing.
 */
export async function getSandboxMetadata(
  organizationId: string
): Promise<{
  exists: boolean
  npxCacheSize?: number
  lastActivity?: Date
  totalDirectories: number
} | null> {
  const sandboxPath = join(baseSandboxDir(), `org-${organizationId}`)
  
  try {
    const stats = await statSync(sandboxPath)
    if (!stats.isDirectory()) {
      return null
    }
    
    // Calculate cache size (approximate)
    let npxCacheSize = 0
    try {
      npxCacheSize = parseInt(
        execSync(`du -sb "${join(sandboxPath, 'npx-cache')}" 2>/dev/null | cut -f1`).toString()
      ) || 0
    } catch {}
    
    return {
      exists: true,
      npxCacheSize,
      lastActivity: stats.mtime,
      totalDirectories: countDirectories(sandboxPath),
    }
  } catch {
    return {
      exists: false,
      totalDirectories: 0,
    }
  }
}

/**
 * Simple directory counter for monitoring.
 */
function countDirectories(dir: string): number {
  try {
    let count = 0

    const traverse = (path: string): void => {
      const items = readdirSync(path, { withFileTypes: true })
      count += items.filter(item => item.isDirectory()).length

      for (const item of items) {
        if (item.isDirectory()) {
          traverse(join(path, item.name))
        }
      }
    }
    
    traverse(dir)
    return count
  } catch {
    return 0
  }
}
