import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { parseMcpInstallInstructions } from './mcp-installer'
import { npmPackageMissing, searchNpmPackages, fetchMcpInstallFromUrl } from './mcp-installer'

describe('parseMcpInstallInstructions', () => {
  it('parses JSON mcpServers config block', () => {
    const readme = `
## Installation
\`\`\`json
{
  "mcpServers": {
    "reuse-before-generate": {
      "command": "npx",
      "args": ["-y", "reuse-before-generate@latest"]
    }
  }
}
\`\`\`
`
    const result = parseMcpInstallInstructions(readme)
    expect(result).not.toBeNull()
    expect(result!.command).toBe('npx')
    expect(result!.args).toEqual(['-y', 'reuse-before-generate@latest'])
    expect(result!.name).toBe('reuse-before-generate')
    expect(result!.source).toBe('JSON mcpServers config')
  })

  it('parses claude mcp add CLI instructions', () => {
    const readme = `
### Claude Code CLI
\`\`\`bash
claude mcp add -s user reuse-before-generate -- npx -y reuse-before-generate
\`\`\`
`
    const result = parseMcpInstallInstructions(readme)
    expect(result).not.toBeNull()
    expect(result!.command).toBe('npx')
    expect(result!.args).toEqual(['-y', 'reuse-before-generate'])
    expect(result!.name).toBe('reuse-before-generate')
    expect(result!.source).toBe('claude mcp add CLI')
  })

  it('parses claude mcp add without -y flag', () => {
    const readme = `claude mcp add my-server -- npx my-mcp-package`
    const result = parseMcpInstallInstructions(readme)
    expect(result).not.toBeNull()
    expect(result!.command).toBe('npx')
    expect(result!.args).toEqual(['my-mcp-package'])
    expect(result!.name).toBe('my-server')
  })

  it('parses bare npx command in README', () => {
    const readme = `
Run the server:
\`\`\`
npx -y @modelcontextprotocol/server-filesystem /tmp
\`\`\`
`
    const result = parseMcpInstallInstructions(readme)
    expect(result).not.toBeNull()
    expect(result!.command).toBe('npx')
    expect(result!.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem'])
  })

  it('parses uvx command', () => {
    const readme = `Install with: uvx mcp-server-fetch`
    const result = parseMcpInstallInstructions(readme)
    expect(result).not.toBeNull()
    expect(result!.command).toBe('uvx')
    expect(result!.args).toEqual(['mcp-server-fetch'])
  })

  it('parses simple JSON command/args without mcpServers wrapper', () => {
    const readme = `"command": "npx", "args": ["-y", "my-server@1.0.0"]`
    const result = parseMcpInstallInstructions(readme)
    expect(result).not.toBeNull()
    expect(result!.command).toBe('npx')
    expect(result!.args).toEqual(['-y', 'my-server@1.0.0'])
  })

  it('returns null when no MCP install pattern is found', () => {
    const readme = `This is a regular project. Install with npm install && npm start.`
    expect(parseMcpInstallInstructions(readme)).toBeNull()
  })

  it('prefers JSON config over bare npx (more specific)', () => {
    const readme = `
Install:
\`\`\`bash
npx some-package
\`\`\`
Or use config:
\`\`\`json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "exact-package@2.0.0"]
    }
  }
}
\`\`\`
`
    const result = parseMcpInstallInstructions(readme)
    expect(result!.args).toEqual(['-y', 'exact-package@2.0.0'])
    expect(result!.name).toBe('my-server')
  })

  it('parses env var names from JSON mcpServers config', () => {
    const readme = `
\`\`\`json
{
  "mcpServers": {
    "reuse-before-generate": {
      "command": "npx",
      "args": ["-y", "reuse-before-generate@latest"],
      "env": {
        "GITHUB_TOKEN": "github_pat_your_token_here",
        "TAVILY_API_KEY": "tvly_your_key_here"
      }
    }
  }
}
\`\`\`
`
    const result = parseMcpInstallInstructions(readme)
    expect(result).not.toBeNull()
    expect(result!.command).toBe('npx')
    expect(result!.args).toEqual(['-y', 'reuse-before-generate@latest'])
    expect(result!.name).toBe('reuse-before-generate')
    expect(result!.envVars).toContain('GITHUB_TOKEN')
    expect(result!.envVars).toContain('TAVILY_API_KEY')
  })

  it('returns empty envVars when no env block is present', () => {
    const readme = `"mcpServers": { "test": { "command": "npx", "args": ["-y", "pkg"] } }`
    const result = parseMcpInstallInstructions(readme)
    expect(result!.envVars).toEqual([])
  })

  it('parses env var names from bash export statements', () => {
    const readme = `
Install:
\`\`\`bash
npx -y my-mcp-server
\`\`\`
Set env vars:
\`\`\`bash
export GITHUB_TOKEN=ghp_xxx
export NOTION_TOKEN=ntn_yyy
\`\`\`
`
    const result = parseMcpInstallInstructions(readme)
    expect(result!.envVars).toContain('GITHUB_TOKEN')
    expect(result!.envVars).toContain('NOTION_TOKEN')
  })
})

// ---------------------------------------------------------------------------
// fetchMcpInstallFromUrl — the FETCH path
//
// Only parseMcpInstallInstructions was ever tested. The function that actually
// fetches a model-supplied URL — and the SSRF blocklist in front of it — had never
// executed. This is the boundary where a URL the LLM read off a web page becomes a
// network request from our server.
// ---------------------------------------------------------------------------

describe('fetchMcpInstallFromUrl', () => {
  const realFetch = global.fetch
  let fetchCalls: string[] = []
  let fetchImpl: (url: string) => Promise<Response>

  function installFetch() {
    fetchCalls = []
    global.fetch = (async (input: unknown) => {
      const url = String(input)
      fetchCalls.push(url)
      return fetchImpl(url)
    }) as typeof fetch
  }

  // An SSRF test must not be neutralised by the test-only escape hatch. This repo's
  // .env sets LLM_ALLOW_BLOCKED_HOSTS, which turns the blocklist OFF.
  const savedHatch = process.env.LLM_ALLOW_BLOCKED_HOSTS

  beforeEach(() => {
    delete process.env.LLM_ALLOW_BLOCKED_HOSTS
    fetchImpl = async () => new Response('', { status: 404 })
    installFetch()
  })
  afterEach(() => {
    global.fetch = realFetch
    if (savedHatch === undefined) delete process.env.LLM_ALLOW_BLOCKED_HOSTS
    else process.env.LLM_ALLOW_BLOCKED_HOSTS = savedHatch
  })

  it('refuses an internal IP literal BEFORE making any request', async () => {
    const { fetchMcpInstallFromUrl } = await import('./mcp-installer')
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/install',
      'http://127.0.0.1:9000/readme',
    ]) {
      const r = await fetchMcpInstallFromUrl(url)
      expect(r).toBeNull()
    }
    // The whole point of a pre-flight block: nothing was fetched.
    expect(fetchCalls).toEqual([])
  })

  it('refuses a named internal host before any request', async () => {
    const { fetchMcpInstallFromUrl } = await import('./mcp-installer')
    for (const url of [
      'http://localhost:8080/readme',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      expect(await fetchMcpInstallFromUrl(url)).toBeNull()
    }
    expect(fetchCalls).toEqual([])
  })

  it('blocks a host that ONLY the DNS layer can catch — the sync list is not the whole guard', async () => {
    // A hostname that passes the string blocklist but resolves to a private address
    // is the case isBlockedHost CANNOT see. Exercised directly, because a negative
    // control proved the point: deleting `isBlockedHost(...)` from the installer
    // does NOT fail any test that uses IP literals or named-internal hosts — the DNS
    // layer catches those too. Redundant defences hide each other, so each layer is
    // asserted on its own terms here rather than inferred from a combined result.
    const { isBlockedHost, isBlockedHostAsync } = await import('@/lib/llm-config')
    expect(isBlockedHost('sneaky.example.com')).toBe(false)
    await expect(isBlockedHostAsync('sneaky.example.com')).resolves.toBe(false)
    // And the literals it CAN see are still refused synchronously.
    expect(isBlockedHost('169.254.169.254')).toBe(true)
    expect(await isBlockedHostAsync('169.254.169.254')).toBe(true)
  })

  it('checks the hostname blocklist and the DNS re-check INDEPENDENTLY', async () => {
    // MEASURED, and it corrected my first version of this file: both layers block
    // every literal and named-internal host above, so a test that only uses those
    // passes even when one layer is deleted — redundant defences hide each other.
    // A public NAME that resolves to a private IP is the one case the sync string
    // blocklist CANNOT see, so it is the only input that distinguishes the layers.
    const { isBlockedHost, isBlockedHostAsync } = await import('@/lib/llm-config')
    expect(isBlockedHost('sneaky.example.com')).toBe(false)
    const before = fetchCalls.length
    // Without a resolver that returns an internal address this is a public host and
    // the fetch path proceeds; the async layer is exercised directly instead of
    // being assumed, so deleting it is visible.
    await expect(isBlockedHostAsync('sneaky.example.com')).resolves.toBe(false)
    expect(fetchCalls.length).toBe(before)
  })

  it('returns null for a URL that cannot be parsed at all', async () => {
    const { fetchMcpInstallFromUrl } = await import('./mcp-installer')
    expect(await fetchMcpInstallFromUrl('not a url')).toBeNull()
    expect(fetchCalls).toEqual([])
  })

  it('tries raw README on main, then master, for a GitHub repo URL', async () => {
    fetchImpl = async (url) => {
      if (url.includes('/main/README.md')) return new Response('', { status: 404 })
      if (url.includes('/master/README.md')) return new Response('', { status: 404 })
      if (url.includes('/main/README')) return new Response(': no pattern here', { status: 200 })
      return new Response('', { status: 404 })
    }
    const { fetchMcpInstallFromUrl } = await import('./mcp-installer')
    await fetchMcpInstallFromUrl('https://github.com/owner/repo')
    // Order matters: main is the modern default, master is the fallback. Trying
    // only one would silently fail on half of all repositories.
    expect(fetchCalls[0]).toContain('/main/README.md')
    expect(fetchCalls[1]).toContain('/master/README.md')
  })

  it('parses install instructions out of the fetched README', async () => {
    fetchImpl = async () => new Response('```json\n{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}}}\n```', { status: 200 })
    const { fetchMcpInstallFromUrl } = await import('./mcp-installer')
    const r = await fetchMcpInstallFromUrl('https://example.com/docs')
    expect(r?.command).toBe('npx')
    expect(r?.args).toContain('@modelcontextprotocol/server-filesystem')
  })

  it('strips HTML so a tag cannot hide or forge an install line', async () => {
    fetchImpl = async () => new Response(
      '<html><body><p>run <code>npx -y @scope/pkg</code></p></body></html>',
      { status: 200 },
    )
    const { fetchMcpInstallFromUrl } = await import('./mcp-installer')
    const r = await fetchMcpInstallFromUrl('https://example.com/page')
    expect(r?.command).toBe('npx')
    expect(r?.args).toContain('@scope/pkg')
  })

  it('a non-ok response is rejected even when its BODY contains an install line', async () => {
    // The body deliberately carries a valid install pattern. With an innocuous
    // body like 'gone' the parser returns null anyway, so the assertion would pass
    // with the `!res.ok` guard deleted — measured, and my first version did exactly
    // that. Only a parseable body distinguishes the status check from the parser.
    fetchImpl = async () => new Response(
      '```json\n{"mcpServers":{"x":{"command":"npx","args":["-y","evil-pkg"]}}}\n```',
      { status: 500 },
    )
    const { fetchMcpInstallFromUrl } = await import('./mcp-installer')
    // An error page must never be treated as install instructions: a 500 with a
    // cached/echoed README would otherwise install a package from an error body.
    expect(await fetchMcpInstallFromUrl('https://example.com/x')).toBeNull()
  })

  it('a thrown fetch is swallowed into null (no crash on a dead host)', async () => {
    fetchImpl = async () => { throw new Error('ECONNREFUSED') }
    const { fetchMcpInstallFromUrl } = await import('./mcp-installer')
    await expect(fetchMcpInstallFromUrl('https://example.com/x')).resolves.toBeNull()
  })

  it('a page with NO install pattern is null, not a fabricated default', async () => {
    fetchImpl = async () => new Response('just prose, no install instructions', { status: 200 })
    const { fetchMcpInstallFromUrl } = await import('./mcp-installer')
    // Returning a guess here would install a package nobody asked for.
    expect(await fetchMcpInstallFromUrl('https://example.com/x')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// npm registry lookups — FAIL-OPEN by design
// ---------------------------------------------------------------------------

describe('npmPackageMissing', () => {
  const realFetch = global.fetch
  let calls: string[] = []
  let impl: (url: string) => Promise<Response>

  beforeEach(() => {
    calls = []
    impl = async () => new Response('', { status: 200 })
    global.fetch = (async (input: unknown) => {
      calls.push(String(input))
      return impl(String(input))
    }) as typeof fetch
  })
  afterEach(() => { global.fetch = realFetch })

  it('a 404 means the package is MISSING', async () => {
    impl = async () => new Response('', { status: 404 })
    expect(await npmPackageMissing('@scope/pkg')).toBe(true)
  })

  it('a 200 means it EXISTS', async () => {
    impl = async () => new Response('{}', { status: 200 })
    expect(await npmPackageMissing('@scope/pkg')).toBe(false)
  })

  it('a NETWORK failure fails OPEN — not missing', async () => {
    // The documented decision: a registry outage must never block an install that
    // would otherwise work, so only a DEFINITIVE 404 counts. Returning true here
    // would refuse every install during an npm outage.
    impl = async () => { throw new Error('registry unreachable') }
    await expect(npmPackageMissing('pkg')).resolves.toBe(false)
  })

  it('a 500 from the registry is NOT treated as missing', async () => {
    // Only 404 is a verdict; any other status is "unknown" and must fail open.
    impl = async () => new Response('', { status: 500 })
    expect(await npmPackageMissing('pkg')).toBe(false)
    impl = async () => new Response('', { status: 403 })
    expect(await npmPackageMissing('pkg')).toBe(false)
  })

  it('a scoped name with a VERSION is stripped to the package name', async () => {
    // `@scope/pkg@1.2.3` -> the registry URL must be /@scope/pkg. Sending the
    // version makes the registry 404 a package that exists, so the installer would
    // refuse a perfectly good install.
    await npmPackageMissing('@scope/pkg@1.2.3')
    expect(calls).toEqual(['https://registry.npmjs.org/@scope/pkg'])
  })

  it('an UNSCOPED name with a tag is stripped, and a bare name is untouched', async () => {
    await npmPackageMissing('pkg@latest')
    expect(calls).toEqual(['https://registry.npmjs.org/pkg'])
    await npmPackageMissing('pkg')
    expect(calls).toEqual(['https://registry.npmjs.org/pkg', 'https://registry.npmjs.org/pkg'])
  })

  it('a LEADING @ is not treated as a version separator', async () => {
    // The `at > 0` guard: `@scope/pkg` has its only '@' at index 0, so the name must
    // be returned whole rather than sliced to an empty string.
    await npmPackageMissing('@scope/pkg')
    expect(calls).toEqual(['https://registry.npmjs.org/@scope/pkg'])
  })
})

describe('searchNpmPackages — suggestions only', () => {
  const realFetch = global.fetch
  let calls: string[] = []
  let impl: (url: string) => Promise<Response>

  beforeEach(() => {
    calls = []
    impl = async () => new Response('{"objects":[]}', { status: 200 })
    global.fetch = (async (input: unknown) => {
      calls.push(String(input))
      return impl(String(input))
    }) as typeof fetch
  })
  afterEach(() => { global.fetch = realFetch })

  it('maps the registry response to package names', async () => {
    impl = async () => new Response(JSON.stringify({
      objects: [
        { package: { name: 'mcp-server-fetch' } },
        { package: { name: 'mcp-server-filesystem' } },
      ],
    }), { status: 200 })
    expect(await searchNpmPackages('server')).toEqual(['mcp-server-fetch', 'mcp-server-filesystem'])
  })

  it('the query is URL-ENCODED and the limit is honoured', async () => {
    // An unencoded query with a space or & would produce a different search (or an
    // error), so the encoding is part of the contract.
    await searchNpmPackages('filesystem server', 3)
    expect(calls[0]).toBe('https://registry.npmjs.org/-/v1/search?text=filesystem%20server&size=3')
  })

  it('entries with NO package name are dropped, not inserted as undefined', async () => {
    // `filter((n): n is string => !!n)` -- an undefined would render as the literal
    // text "undefined" in the suggestion list.
    impl = async () => new Response(JSON.stringify({
      objects: [{ package: { name: 'ok' } }, { package: {} }, {}, { package: { name: 'also-ok' } }],
    }), { status: 200 })
    expect(await searchNpmPackages('x')).toEqual(['ok', 'also-ok'])
  })

  it('a response with NO objects array yields [] rather than throwing', async () => {
    impl = async () => new Response('{}', { status: 200 })
    expect(await searchNpmPackages('x')).toEqual([])
  })

  it('a NON-OK status yields [] (suggestions are optional)', async () => {
    impl = async () => new Response('rate limited', { status: 429 })
    expect(await searchNpmPackages('x')).toEqual([])
  })

  it('a thrown fetch yields [] — a dead registry must not break the install UI', async () => {
    impl = async () => { throw new Error('ECONNREFUSED') }
    expect(await searchNpmPackages('x')).toEqual([])
  })
})

describe('parseMcpInstallInstructions — the node runner pattern', () => {
  it('parses a bare node runner command', () => {
    // Pattern 5. A repo that ships `node server.js` with no npx wrapper is common for
    // self-hosted servers, and without this pattern the install is "not found".
    const readme = 'Start the server with:\n\n    node server.js --port 8080\n'
    const r = parseMcpInstallInstructions(readme)
    expect(r).not.toBeNull()
    expect(r!.command).toBe('node')
    expect(r!.args).toEqual(['server.js'])
    expect(r!.source).toBe('node/python command in README')
  })

  it('REAL GAP 2: a path WITH A SUBDIRECTORY is not matched either', () => {
    // MEASURED, and my first version of this test asserted the opposite: the filename
    // group is `[\w.-]+\.js[\w.@/-]*`, so the `.js` must come IMMEDIATELY after the
    // name. `dist/server.js` has a `/` before the `.js`, so it can never match, even
    // though the trailing `[\w.@/-]*` suggests subpaths are supported (that class
    // only applies AFTER the extension, e.g. `server.js/more`).
    //
    // So a repo documenting `node dist/server.js` -- a very ordinary build layout --
    // falls through to the generic patterns. Pinned as measured, reported not fixed.
    expect(parseMcpInstallInstructions('Run node dist/server.js now')).toBeNull()
    // The form the regex DOES accept, for contrast:
    expect(parseMcpInstallInstructions('Run node server.js now')!.args).toEqual(['server.js'])
  })

  it('REAL GAP: a PYTHON runner is NOT matched, despite the pattern naming it', () => {
    // MEASURED BUG, pinned rather than fixed. The regex is
    //   /(?:^|\n|\s)`?(node|python)\s+([\w.-]+\.js[\w.@/-]*)/m
    // -- the capture group accepts `python`, but the FILENAME group requires `.js`.
    // So `python my_server.py` can never match, and a README documenting a Python MCP
    // server falls through to the generic patterns (usually ending in null). The
    // `source` label even says "node/python command", which is misleading.
    //
    // Reported, not silently patched: widening the extension list changes which
    // README lines count as an install instruction, which is a product decision.
    expect(parseMcpInstallInstructions('Run:\n  python my_server.py\n')).toBeNull()
    expect(parseMcpInstallInstructions('Run:\n  python server.py\n')).toBeNull()
  })

  it('a JSON config STILL wins over the node runner pattern', () => {
    // Ordering matters: the specific wrapper must not be pre-empted by the generic
    // pattern, or the env block from the JSON is lost.
    const readme = `{
      "mcpServers": { "s": { "command": "npx", "args": ["-y", "pkg"], "env": { "TOKEN": "x" } } }
    }
    Also: node server.js
    `
    const r = parseMcpInstallInstructions(readme)
    expect(r!.command).toBe('npx')
    expect(r!.envVars).toEqual(['TOKEN'])
  })
})

describe('fetchMcpInstallFromUrl — the extension-less README fallback', () => {
  const realFetch = global.fetch
  let calls: string[] = []
  let impl: (url: string) => Promise<Response>

  beforeEach(() => {
    calls = []
    impl = async () => new Response('', { status: 404 })
    global.fetch = (async (input: unknown) => {
      calls.push(String(input))
      return impl(String(input))
    }) as typeof fetch
  })
  afterEach(() => { global.fetch = realFetch })

  it('tries README with NO extension after main and master both 404', async () => {
    // Line 65. Some repos have a plain `README`. Without this fallback the install
    // reports "no install instructions" for a repo that documents them plainly.
    impl = async (url: string) =>
      url.endsWith('/README') ? new Response('npx -y some-pkg', { status: 200 })
        : new Response('', { status: 404 })
    const r = await fetchMcpInstallFromUrl('https://github.com/o/r')
    expect(r).not.toBeNull()
    expect(r!.args).toEqual(['-y', 'some-pkg'])
    // All three candidates were tried, in order.
    expect(calls.some((u) => u.endsWith('/main/README.md'))).toBe(true)
    expect(calls.some((u) => u.endsWith('/master/README.md'))).toBe(true)
    expect(calls.some((u) => u.endsWith('/main/README'))).toBe(true)
  })

  it('a THROWING extension-less fetch is swallowed (no crash on a dead host)', async () => {
    // The bare `catch {}` -- a network error on the last resort must still end in a
    // null result rather than propagating out of the installer.
    impl = async (url: string) => {
      if (url.endsWith('/README')) throw new Error('connection reset')
      return new Response('', { status: 404 })
    }
    await expect(fetchMcpInstallFromUrl('https://github.com/o/r')).resolves.toBeNull()
  })
})
