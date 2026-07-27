import { describe, expect, it } from 'bun:test'
import { parseMcpInstallInstructions } from './mcp-installer'

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
