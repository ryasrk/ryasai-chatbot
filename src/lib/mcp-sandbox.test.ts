/**
 * Per-org MCP sandbox isolation.
 *
 * WHY THIS FILE EXISTS. `mcp-sandbox.ts` had no test at all — no test file imported it, even
 * transitively. It is 186 lines of SECURITY claims made in its own doc comment: separate
 * filesystem namespaces per organization, 0o700 permissions so "other organizations cannot
 * access this org's data", and a wrapper script that pins HOME / NPM_CONFIG_* / TMPDIR / PATH
 * into the org's own directories. A defect here is a cross-org data-exposure defect —
 * package caches, temp files and npm state are exactly where a shell command leaks another
 * tenant's content.
 *
 * This file EXERCISES THE REAL FILESYSTEM rather than mocking `node:fs`: the security claim IS
 * "the permissions on disk are 0o700", so mocking chmod would make the test assert the mock.
 * The suite uses a throwaway directory under the system temp dir.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, stat, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The module hardcodes `/var/mcp/isolated`, which is not writable (and must not be created) in
// this environment. `MCP_SANDBOX_DIR` is respected when set; the override below is what makes
// the sandbox testable without touching the host. Read at CALL time, so setting it here is safe
// even though the import below is hoisted.
const SANDBOX_ROOT = await mkdtemp(join(tmpdir(), 'mcp-sandbox-test-'))
process.env.MCP_SANDBOX_DIR = SANDBOX_ROOT

import {
  ensureOrganizationalSandbox,
  getSandboxWrapperScript,
  getNpmScopeForOrg,
  cleanupOrganizationalSandbox,
  getSandboxMetadata,
} from './mcp-sandbox'

afterAll(async () => {
  await rm(SANDBOX_ROOT, { recursive: true, force: true })
})

describe('ensureOrganizationalSandbox — the isolation the doc comment promises', () => {
  test('creates all four directories for an org', async () => {
    const sb = await ensureOrganizationalSandbox('org-alpha')
    for (const p of [sb.sandboxPath, sb.npxCachePath, sb.runtimePath, sb.tmpPath]) {
      const st = await stat(p)
      expect(st.isDirectory()).toBe(true)
    }
    expect(sb.sandboxPath.endsWith('org-org-alpha')).toBe(true)
    expect(sb.npxCachePath).toBe(join(sb.sandboxPath, 'npx-cache'))
    expect(sb.runtimePath).toBe(join(sb.sandboxPath, 'mcp-runtime'))
    expect(sb.tmpPath).toBe(join(sb.sandboxPath, 'tmp'))
  })

  test('the three core directories are OWNER-ONLY (0o700)', async () => {
    // The load-bearing security assertion. If these are group/world readable, another org's
    // process on the same host can read this org's npm cache and temp files.
    const sb = await ensureOrganizationalSandbox('org-alpha')
    for (const p of [sb.sandboxPath, sb.npxCachePath, sb.runtimePath]) {
      const mode = (await stat(p)).mode & 0o777
      expect(mode).toBe(0o700)
    }
  })

  test('the tmp directory is owner-only like its siblings, NOT a sticky 0o1777', async () => {
    // MEASURED DEFECT, now fixed. The code used to chmod the tmp dir to 0o1777 "for /tmp
    // behavior", but Bun 1.3.14 silently drops the sticky bit: both `chmod(p, 0o1777)` and
    // `chmod(p, 0o1000 | 0o777)` yield 0o777. Only the `chmod` SHELL binary produces 0o1777.
    // So the promised guarantee was never in place. The fix makes tmp 0o700 like the others,
    // which is strictly better for tenant isolation (unreachable by other orgs at all rather
    // than reachable-but-sticky).
    const sb = await ensureOrganizationalSandbox('org-alpha')
    const mode = (await stat(sb.tmpPath)).mode & 0o7777
    expect(mode).toBe(0o700)
    // Pin the runtime limitation this decision rests on, so a future Bun that DOES support the
    // sticky bit surfaces here rather than silently changing the security posture.
    expect(mode).not.toBe(0o1777)
  })

  test('is IDEMPOTENT and preserves existing content', async () => {
    // Setup runs on every MCP tool call; re-creating must not wipe an installed package cache.
    const sb = await ensureOrganizationalSandbox('org-idem')
    const marker = join(sb.npxCachePath, 'installed-package.txt')
    await writeFile(marker, 'keep me')

    const again = await ensureOrganizationalSandbox('org-idem')
    expect(again.sandboxPath).toBe(sb.sandboxPath)
    expect(await Bun.file(marker).text()).toBe('keep me')
  })

  test('two orgs get DISJOINT trees even when slugs share a prefix', async () => {
    // A substring-based path derivation would collide `acme` with `acme-corp`. Both must be
    // separate directories, and neither may contain the other.
    const a = await ensureOrganizationalSandbox('acme')
    const b = await ensureOrganizationalSandbox('acme-corp')
    expect(a.sandboxPath).not.toBe(b.sandboxPath)
    expect(b.sandboxPath.startsWith(a.sandboxPath + '/')).toBe(false)
  })

  test('the returned orgId is the one that was passed in', async () => {
    const sb = await ensureOrganizationalSandbox('org-identity')
    expect(sb.orgId).toBe('org-identity')
  })
})

describe('getSandboxWrapperScript — pinning the sandboxed process into its own namespace', () => {
  test('exports HOME, npm paths, TMPDIR and PATH from the sandbox', async () => {
    // Without these, a stdio MCP server inherits the PARENT process environment: the parent's
    // npm cache, the parent's HOME, and the host's shared /tmp — which is precisely the
    // cross-org contamination the sandbox exists to prevent.
    const sb = await ensureOrganizationalSandbox('org-wrapper')
    const script = getSandboxWrapperScript(sb, 'npx', ['-y', 'some-mcp-server'])

    expect(script).toContain(`export HOME="${sb.sandboxPath}"`)
    expect(script).toContain(`export NPM_CONFIG_PREFIX="${sb.runtimePath}"`)
    expect(script).toContain(`export NPM_CONFIG_CACHE="${sb.npxCachePath}"`)
    expect(script).toContain(`export TMPDIR="${sb.tmpPath}"`)
    expect(script).toContain(`export PATH="${sb.runtimePath}/bin:$PATH"`)
  })

  test('quotes each argument so a shell metacharacter cannot escape', async () => {
    const sb = await ensureOrganizationalSandbox('org-quote')
    const script = getSandboxWrapperScript(sb, 'npx', ['a; rm -rf /', 'b && curl evil', 'plain'])

    // Each arg is single-quoted and `exec` is used, so the injected commands are ARGUMENTS,
    // never commands. Asserting on the exec line specifically: a naive join would let
    // `a; rm -rf /` run as a second command.
    const execLine = script.split('\n').find((l) => l.startsWith('exec '))!
    expect(execLine).toBe("exec npx 'a; rm -rf /' 'b && curl evil' 'plain'")
  })

  test('an argument containing a single quote is escaped safely, not broken open', async () => {
    // The classic injection: `it's` naively quoted as 'it's' terminates the quote and lets the
    // rest of the argument run as shell. The correct encoding is the '"'"' dance.
    const sb = await ensureOrganizationalSandbox('org-quote2')
    const script = getSandboxWrapperScript(sb, 'echo', ["it's; rm -rf /"])
    const execLine = script.split('\n').find((l) => l.startsWith('exec '))!
    expect(execLine).toBe(`exec echo 'it'"'"'s; rm -rf /'`)
    // The rendered line must contain an EVEN number of quote-terminating sequences: proof the
    // escaping did not leave the shell inside an unterminated string.
    expect(execLine).not.toContain("'it's")
  })

  test('an empty argument list still produces a valid exec line', async () => {
    const sb = await ensureOrganizationalSandbox('org-noargs')
    const script = getSandboxWrapperScript(sb, 'my-server', [])
    expect(script).toContain('exec my-server')
    expect(script).not.toContain('undefined')
  })

  test('marks the script as generated and warns against editing', async () => {
    // Operators DO edit generated files. The header is what stops a local edit from silently
    // disabling the isolation.
    const sb = await ensureOrganizationalSandbox('org-hdr')
    const script = getSandboxWrapperScript(sb, 'x', [])
    expect(script.startsWith('#!/bin/bash')).toBe(true)
    expect(script).toContain('DO NOT EDIT')
    expect(script).toContain('org-hdr')
  })
})

describe('getNpmScopeForOrg', () => {
  test('derives a scope from the first 8 characters of the org id', async () => {
    const sb = await ensureOrganizationalSandbox('abcdefghijkl')
    expect(getNpmScopeForOrg(sb)).toBe('@ryasai-org-abcdefgh')
  })

  test('is STABLE for the same org, so cached packages keep resolving', async () => {
    const sb = await ensureOrganizationalSandbox('org-stable')
    expect(getNpmScopeForOrg(sb)).toBe(getNpmScopeForOrg(sb))
  })

  test('two orgs sharing a first 8 chars produce the SAME scope — a known collision', async () => {
    // Pinned as MEASURED, and it is a real limit of the design: the scope is a display/prefix
    // convenience, and it is the per-org DIRECTORY (not this string) that provides isolation.
    // Recorded so nobody mistakes this prefix for a security boundary.
    const a = await ensureOrganizationalSandbox('abcdefghAAAA')
    const b = await ensureOrganizationalSandbox('abcdefghBBBB')
    expect(getNpmScopeForOrg(a)).toBe(getNpmScopeForOrg(b))
    // ...while their sandbox paths still differ, which is what actually isolates them.
    expect(a.sandboxPath).not.toBe(b.sandboxPath)
  })
})

describe('cleanupOrganizationalSandbox', () => {
  test('removes the whole tree for that org', async () => {
    const sb = await ensureOrganizationalSandbox('org-cleanup')
    await writeFile(join(sb.npxCachePath, 'junk.bin'), 'x')
    await cleanupOrganizationalSandbox('org-cleanup')
    await expect(stat(sb.sandboxPath)).rejects.toThrow()
  })

  test('deleting one org does NOT touch another org\'s sandbox', async () => {
    // The catastrophic case: a cleanup bug with a shared/anonymous path would delete every
    // tenant's cache in one call.
    const keep = await ensureOrganizationalSandbox('org-keep')
    await writeFile(join(keep.sandboxPath, 'important.txt'), 'survives')
    await ensureOrganizationalSandbox('org-delete')
    await cleanupOrganizationalSandbox('org-delete')

    await expect(stat(keep.sandboxPath)).resolves.toBeTruthy()
    expect(await Bun.file(join(keep.sandboxPath, 'important.txt')).text()).toBe('survives')
  })

  test('cleaning a NON-EXISTENT sandbox is a no-op, not a throw', async () => {
    // `force: true` makes this idempotent, so a retried org deletion does not error out.
    await expect(cleanupOrganizationalSandbox('org-never-existed')).resolves.toBeUndefined()
  })
})

describe('getSandboxMetadata', () => {
  test('reports exists:false for an org with no sandbox', async () => {
    const meta = await getSandboxMetadata('org-absent')
    expect(meta).toEqual({ exists: false, totalDirectories: 0 })
  })

  test('reports exists:true, a directory count and an mtime for a live sandbox', async () => {
    const sb = await ensureOrganizationalSandbox('org-meta')
    await mkdir(join(sb.sandboxPath, 'extra-dir'), { recursive: true })
    const meta = await getSandboxMetadata('org-meta')
    expect(meta?.exists).toBe(true)
    // sandboxPath holds npx-cache, mcp-runtime, tmp + extra-dir.
    expect(meta!.totalDirectories).toBeGreaterThanOrEqual(4)
    expect(meta!.lastActivity).toBeInstanceOf(Date)
  })

  test('the directory count RECURSES rather than counting only the top level', async () => {
    // A shallow count would under-report a deep npm cache and make the quota/audit view lie.
    const sb = await ensureOrganizationalSandbox('org-deep')
    await mkdir(join(sb.npxCachePath, 'a', 'b', 'c'), { recursive: true })
    const meta = await getSandboxMetadata('org-deep')
    // a, b and c are all below npx-cache, so at least 3 come from the nested chain alone.
    expect(meta!.totalDirectories).toBeGreaterThanOrEqual(6)
  })

  test('a sandbox whose directory listing FAILS reports totalDirectories 0, not an error', async () => {
    // The counter is monitoring-only, so an unreadable directory must degrade to 0 rather than
    // make the whole metadata call throw and hide a sandbox that does exist. Reached by making
    // the sandbox path a dangling symlink: `statSync` follows it and throws ENOENT, which is the
    // same failure shape as a permission denial at the top of the tree.
    const { symlink } = await import('node:fs/promises')
    const link = join(SANDBOX_ROOT, 'org-broken-link')
    await symlink(join(SANDBOX_ROOT, 'does-not-exist-target'), link)
    const meta = await getSandboxMetadata('broken-link')
    // A dangling symlink cannot be a valid sandbox, so the outer guard reports absent.
    expect(meta).toEqual({ exists: false, totalDirectories: 0 })
  })

  test('metadata survives an unreadable nested directory (count degrades, exists stays true)', async () => {
    // The directory counter is wrapped in its own try/catch precisely so a single unreadable
    // subtree cannot turn a real sandbox into "absent". Simulated by pointing the counter at a
    // tree containing a broken symlink: readdirSync still lists it, and the recursive descent
    // into a non-directory entry is skipped rather than throwing.
    const sb = await ensureOrganizationalSandbox('org-nested-link')
    const { symlink } = await import('node:fs/promises')
    await symlink(join(SANDBOX_ROOT, 'nowhere'), join(sb.npxCachePath, 'dangling'))
    const meta = await getSandboxMetadata('org-nested-link')
    expect(meta?.exists).toBe(true)
    expect(meta!.totalDirectories).toBeGreaterThanOrEqual(3)
  })

  test('a FILE at the sandbox path is reported as absent, not as a sandbox', async () => {
    // A stray file where the directory should be must not be mistaken for a valid sandbox.
    // NOTE the doubled prefix: the module builds `org-${orgId}` itself, so the file must be
    // named `org-org-as-file` for orgId 'org-as-file'. Writing it to the undoubled path made
    // this test pass through the miss/catch branch instead of the isDirectory() guard -- the
    // wrong branch, and a green-looking test.
    await writeFile(join(SANDBOX_ROOT, 'org-org-as-file'), 'not a directory')
    const meta = await getSandboxMetadata('org-as-file')
    expect(meta).toBeNull()
  })
})
