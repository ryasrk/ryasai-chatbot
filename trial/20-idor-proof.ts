/**
 * Prove the cross-tenant IDOR is closed, at runtime.
 * Creates an MCP server under org A, then queries it as org B.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'
import { hr } from './lib'

async function main() {
  const stamp = Date.now().toString(36)
  const a = await bypassOrg(() => db.organization.create({
    data: { name: `A ${stamp}`, slug: `idor-a-${stamp}`, licenseStatus: 'valid', licensePlan: 'flat', licenseValidatedAt: new Date() },
    select: { id: true },
  }))
  const b = await bypassOrg(() => db.organization.create({
    data: { name: `B ${stamp}`, slug: `idor-b-${stamp}`, licenseStatus: 'valid', licensePlan: 'flat', licenseValidatedAt: new Date() },
    select: { id: true },
  }))

  const server = await bypassOrg(async () => {
    enterWithOrg(a.id)
    return db.mcpServer.create({
      data: { organizationId: a.id, name: 'Org A Secret Server', transport: 'sse', url: 'https://secret.example/mcp', isEnabled: true },
      select: { id: true, name: true },
    })
  })

  hr('SETUP')
  console.log(`org A = ${a.id}`)
  console.log(`org B = ${b.id}`)
  console.log(`A's mcpServer id = ${server.id}`)

  hr('ATTACK 1: org B reads A\'s server by id (findUnique — old code)')
  const leak = await bypassOrg(async () => {
    enterWithOrg(b.id)
    return db.mcpServer.findUnique({ where: { id: server.id } })
  })
  console.log(`findUnique -> ${leak ? `LEAKED "${leak.name}"` : 'null (scoped)'}`)

  hr('ATTACK 2: same read via findFirst (the fix)')
  const scoped = await bypassOrg(async () => {
    enterWithOrg(b.id)
    return db.mcpServer.findFirst({ where: { id: server.id } })
  })
  console.log(`findFirst  -> ${scoped ? `LEAKED "${scoped.name}"` : 'null (scoped) — FIXED'}`)

  hr('CONTROL: org A reading its OWN server still works')
  const own = await bypassOrg(async () => {
    enterWithOrg(a.id)
    return db.mcpServer.findFirst({ where: { id: server.id } })
  })
  console.log(`findFirst  -> ${own ? `OK "${own.name}"` : 'NULL — REGRESSION!'}`)

  await bypassOrg(async () => {
    await db.mcpServer.deleteMany({ where: { organizationId: { in: [a.id, b.id] } } })
    await db.organization.deleteMany({ where: { id: { in: [a.id, b.id] } } })
    console.log('\ncleaned up test orgs')
  })
  process.exit(0)
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
