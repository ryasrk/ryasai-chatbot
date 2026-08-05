/**
 * MCP installer — fetches a URL (GitHub repo, docs page, etc.) and parses
 * for MCP server install instructions. Extracts command/args from common
 * patterns: claude mcp add, JSON mcpServers config, bare npx/uvx.
 *
 * Used by the agentic dashboard when a user says "install this MCP <github-url>"
 * and the URL is NOT a direct MCP endpoint (no /sse, /mcp, /api/mcp path).
 */
import { isBlockedHost, isBlockedHostAsync } from '@/lib/llm-config'

export interface ParsedMcpInstall {
  command: string
  args: string[]
  name?: string
  envVars: string[] // required env var names (e.g. GITHUB_TOKEN, TAVILY_API_KEY)
  source: string // human-readable description of what pattern matched
}

/**
 * Fetch a URL and parse for MCP install instructions.
 * For GitHub repo URLs, tries raw README first (main/master branches).
 * Returns null if no install pattern is found.
 */
export async function fetchMcpInstallFromUrl(url: string): Promise<ParsedMcpInstall | null> {
  // SSRF check — sync hostname blocklist + async DNS-rebinding re-check
  // before any fetch. Mirrors mcp-client.ts/plugin-registry.ts hardening.
  try {
    const parsed = new URL(url)
    if (isBlockedHost(parsed.hostname)) return null
    if (await isBlockedHostAsync(parsed.hostname)) return null
  } catch {
    return null
  }

  const text = await fetchUrlContent(url)
  if (!text) return null
  return parseMcpInstallInstructions(text)
}

async function fetchUrlContent(url: string): Promise<string | null> {
  // GitHub repo URL → try raw README on main/master branches
  const ghMatch = url.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/?$/)
  if (ghMatch) {
    const [, owner, repo] = ghMatch
    for (const branch of ['main', 'master']) {
      try {
        const res = await fetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`,
          { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'ryasai-chatbot/1.0' } },
        )
        if (res.ok) return await res.text()
      } catch {
        // try next branch
      }
    }
  }

  // Generic URL fetch
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'ryasai-chatbot/1.0' },
    })
    if (!res.ok) return null
    let text = await res.text()
    // Strip HTML tags if it's HTML
    if (text.includes('<html') || text.includes('<!DOCTYPE')) {
      text = text.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ')
    }
    return text
  } catch {
    return null
  }
}

/**
 * Parse text for MCP install instructions. Tries patterns in order of specificity:
 * 1. JSON mcpServers config block (most specific — includes exact command + args)
 * 2. "claude mcp add <name> -- <command> <args>" CLI instructions
 * 3. Bare "npx -y <pkg>" or "uvx <pkg>" in code blocks (least specific — fallback)
 */
export function parseMcpInstallInstructions(text: string): ParsedMcpInstall | null {
  // Parse env var names once — applies to all patterns.
  const envVars = parseEnvVarNames(text)

  // Pattern 1: JSON mcpServers config — "command": "npx", "args": ["-y", "pkg@latest"]
  const jsonMatch = text.match(
    /"mcpServers"\s*:\s*\{\s*(?:"[^"]+"\s*:\s*\{)?\s*"command"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*\[([^\]]+)\]/,
  )
  if (jsonMatch) {
    const command = jsonMatch[1]
    const args = jsonMatch[2]
      .split(',')
      .map((a) => a.trim().replace(/["']/g, ''))
      .filter(Boolean)
    const nameMatch = text.match(/"mcpServers"\s*:\s*\{\s*"([^"]+)"/)
    if (args.length > 0) {
      return { command, args, name: nameMatch?.[1], envVars, source: 'JSON mcpServers config' }
    }
  }

  // Pattern 2: "claude mcp add [flags] <name> -- <command> <args...>"
  const claudeAddMatch = text.match(
    /claude\s+mcp\s+add\s+(?:-\S+\s+\S+\s+)*([\w-]+)\s+--\s+(npx|uvx|node|python)\s+(.*)/i,
  )
  if (claudeAddMatch) {
    const name = claudeAddMatch[1]
    const command = claudeAddMatch[2]
    const args = parseArgsString(claudeAddMatch[3].trim())
    if (args.length > 0) return { command, args, name, envVars, source: 'claude mcp add CLI' }
  }

  // Pattern 3: bare "npx -y <pkg>" or "npx <pkg>" in a code block or line
  // ponytail: ceiling — this is a heuristic fallback. May match unrelated npx
  // commands in the README. The JSON and claude-mcp-add patterns are preferred.
  const npxMatch = text.match(/(?:^|\n|\s)`?(npx)\s+(-y\s+)?([a-z0-9@][\w@./-]*)/m)
  if (npxMatch) {
    const pkg = npxMatch[3].replace(/['"`]/g, '')
    const hasY = !!npxMatch[2]
    return {
      command: 'npx',
      args: hasY ? ['-y', pkg] : [pkg],
      envVars,
      source: 'npx command in README',
    }
  }

  // Pattern 4: bare "uvx <pkg>"
  const uvxMatch = text.match(/(?:^|\n|\s)`?(uvx)\s+([a-z0-9][\w./-]*)/m)
  if (uvxMatch) {
    return {
      command: 'uvx',
      args: [uvxMatch[2].replace(/['"`]/g, '')],
      envVars,
      source: 'uvx command in README',
    }
  }

  // Pattern 5: simple "command": "npx", "args": [...] without mcpServers wrapper
  const simpleJsonMatch = text.match(
    /"command"\s*:\s*"(npx|uvx|node|python)"\s*,\s*"args"\s*:\s*\[([^\]]+)\]/,
  )
  if (simpleJsonMatch) {
    const command = simpleJsonMatch[1]
    const args = simpleJsonMatch[2]
      .split(',')
      .map((a) => a.trim().replace(/["']/g, ''))
      .filter(Boolean)
    if (args.length > 0) return { command, args, envVars, source: 'JSON command/args config' }
  }

  return null
}

/** "@scope/pkg@1.2.3" -> "@scope/pkg", "pkg@latest" -> "pkg", "@scope/pkg" -> itself. */
function npmPackageName(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

/**
 * Is this npm package a 404?
 *
 * When the package name was guessed rather than read from a README, npx exits
 * before the stdio handshake and the only thing the caller sees is
 * "MCP error -32000: Connection closed" — on a server row that has already been
 * written. Asking the registry first turns that into a sentence someone can act on.
 *
 * ponytail: fails OPEN. A registry outage must never block an install that
 * would otherwise work, so only a definitive 404 counts as missing.
 */
export async function npmPackageMissing(spec: string): Promise<boolean> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${npmPackageName(spec)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(8_000),
      headers: { 'User-Agent': 'ryasai-chatbot/1.0' },
    })
    return res.status === 404
  } catch {
    return false
  }
}

/** Real npm packages matching a name — suggestions only, never auto-installed. */
export async function searchNpmPackages(query: string, limit = 5): Promise<string[]> {
  try {
    const res = await fetch(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`,
      { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'ryasai-chatbot/1.0' } },
    )
    if (!res.ok) return []
    const body = (await res.json()) as { objects?: { package?: { name?: string } }[] }
    return (body.objects ?? []).map((o) => o.package?.name).filter((n): n is string => !!n)
  } catch {
    return []
  }
}

function parseArgsString(s: string): string[] {
  const tokens: string[] = []
  const regex = /"([^"]+)"|'([^']+)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(s)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3])
  }
  return tokens
}

/**
 * Parse env var names from a README. Tries patterns:
 * 1. JSON "env": { "KEY": "..." } block
 * 2. Bash `export KEY=...` or `KEY=your_value` lines
 * 3. Markdown table rows mentioning env vars
 * Returns unique sorted list of UPPER_SNAKE_CASE names.
 */
function parseEnvVarNames(text: string): string[] {
  const names = new Set<string>()

  // Pattern 1: JSON env block — "env": { "GITHUB_TOKEN": "...", "TAVILY_API_KEY": "..." }
  const envBlockMatch = text.match(/"env"\s*:\s*\{([^}]*)\}/)
  if (envBlockMatch) {
    const envBlock = envBlockMatch[1]
    const keyMatches = envBlock.matchAll(/"([A-Z][A-Z0-9_]+)"\s*:/g)
    for (const m of keyMatches) names.add(m[1])
  }

  // Pattern 2: bash export or assignment — export GITHUB_TOKEN=... or GITHUB_TOKEN=your_token
  const exportMatches = text.matchAll(/(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/g)
  for (const m of exportMatches) {
    // Filter out common false positives (command names, JSON keys already caught)
    const name = m[1]
    if (!['PATH', 'HOME', 'NODE_ENV', 'PWD', 'SHELL'].includes(name)) {
      names.add(name)
    }
  }

  // Pattern 3: backtick-quoted env var names — `GITHUB_TOKEN`
  const backtickMatches = text.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)
  for (const m of backtickMatches) names.add(m[1])

  return Array.from(names).sort()
}
