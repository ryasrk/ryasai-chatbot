import { db } from '@/lib/db'

async function main() {
  const existing = await db.mcpServer.findFirst({ where: { name: 'reuse-before-generate' } })
  if (existing) {
    console.log('Already registered:', existing.id)
    process.exit(0)
  }

  const server = await db.mcpServer.create({
    data: {
      name: 'reuse-before-generate',
      description: 'Check GitHub, npm, PyPI for maintained alternatives before building something new. Call check_before_building before scaffolding any new project or module.',
      transport: 'stdio',
      command: 'npx',
      args: '["-y","reuse-before-generate@latest"]',
      url: '',
      envJson: '{}',
      isEnabled: true,
      chatEnabled: true,
      agenticEnabled: true,
    },
  })

  console.log('Registered MCP server:', server.id)
  console.log('Name:', server.name)
  console.log('Command:', server.command, server.args)
  console.log('The planner will now see mcp:' + server.id + ':check_before_building as an available tool.')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
