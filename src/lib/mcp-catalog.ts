export interface McpCatalogEntry {
  name: string
  description: string
  category: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  installInstructions: string
  repoUrl: string
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  { name: 'Filesystem', description: 'Read/write files on the local filesystem', category: 'File Systems', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'], installInstructions: 'npx -y @modelcontextprotocol/server-filesystem /allowed/path', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem' },
  { name: 'Google Drive', description: 'Google Drive file access', category: 'File Systems', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-drive'], installInstructions: 'npx -y @modelcontextprotocol/server-google-drive (requires Google OAuth)', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-drive' },
  { name: 'PostgreSQL', description: 'Read-only PostgreSQL database access', category: 'Databases', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://...'], installInstructions: 'npx -y @modelcontextprotocol/server-postgres "postgresql://user:pass@host/db"', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres' },
  { name: 'SQLite', description: 'SQLite database access', category: 'Databases', transport: 'stdio', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', '/path/to/db'], installInstructions: 'uvx mcp-server-sqlite --db-path /path/to/db', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite' },
  { name: 'Brave Search', description: 'Web search using Brave Search API', category: 'Search', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], installInstructions: 'npx -y @modelcontextprotocol/server-brave-search (requires BRAVE_API_KEY env)', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search' },
  { name: 'Fetch', description: 'Fetch web pages and extract content', category: 'Search', transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], installInstructions: 'uvx mcp-server-fetch', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch' },
  { name: 'Puppeteer', description: 'Browser automation for web scraping', category: 'Browser Automation', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], installInstructions: 'npx -y @modelcontextprotocol/server-puppeteer', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer' },
  { name: 'Memory', description: 'Persistent knowledge graph memory', category: 'Knowledge & Memory', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], installInstructions: 'npx -y @modelcontextprotocol/server-memory', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory' },
  { name: 'Sequential Thinking', description: 'Dynamic problem-solving through thought sequencing', category: 'Knowledge & Memory', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], installInstructions: 'npx -y @modelcontextprotocol/server-sequential-thinking', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking' },
  { name: 'GitHub', description: 'GitHub API access — repos, issues, PRs', category: 'Developer Tools', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], installInstructions: 'npx -y @modelcontextprotocol/server-github (requires GITHUB_PERSONAL_ACCESS_TOKEN env)', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github' },
  { name: 'GitLab', description: 'GitLab API access — projects, issues, MRs', category: 'Developer Tools', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'], installInstructions: 'npx -y @modelcontextprotocol/server-gitlab (requires GITLAB_PERSONAL_ACCESS_TOKEN env)', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab' },
  { name: 'AWS', description: 'AWS service access — S3, EC2, Lambda', category: 'Cloud Platforms', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-aws'], installInstructions: 'npx -y @modelcontextprotocol/server-aws (requires AWS credentials)', repoUrl: 'https://github.com/modelcontextprotocol/servers' },
  { name: 'Slack', description: 'Slack API — channels, messages, files', category: 'Communication', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], installInstructions: 'npx -y @modelcontextprotocol/server-slack (requires SLACK_BOT_TOKEN env)', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack' },
  { name: 'Google Maps', description: 'Google Maps — places, directions, geocoding', category: 'Location Services', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-maps'], installInstructions: 'npx -y @modelcontextprotocol/server-google-maps (requires GOOGLE_MAPS_API_KEY env)', repoUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps' },
  { name: 'Time', description: 'Time and timezone conversion', category: 'Productivity', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-time'], installInstructions: 'npx -y @modelcontextprotocol/server-time', repoUrl: 'https://github.com/modelcontextprotocol/servers' },
  { name: 'Sentry', description: 'Sentry error tracking access', category: 'Monitoring', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sentry'], installInstructions: 'npx -y @modelcontextprotocol/server-sentry (requires SENTRY_AUTH_TOKEN env)', repoUrl: 'https://github.com/modelcontextprotocol/servers' },
  { name: 'Stripe', description: 'Stripe API — payments, customers, subscriptions', category: 'Finance', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-stripe'], installInstructions: 'npx -y @modelcontextprotocol/server-stripe (requires STRIPE_API_KEY env)', repoUrl: 'https://github.com/modelcontextprotocol/servers' },
]

export const MCP_CATALOG_CATEGORIES: string[] = Array.from(
  new Set(MCP_CATALOG.map((e) => e.category)),
).sort()
