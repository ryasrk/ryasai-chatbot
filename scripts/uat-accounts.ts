/**
 * Creates 9 UAT accounts, one per persona, in the EXISTING org so they share the seeded data.
 *
 * WHY SEPARATE ACCOUNTS: the session is keyed per USER (`User.sessionVersion` increments on each login and a stale
 * token is rejected), so two logins for the SAME user invalidate each other. The first UAT run shared one account and
 * every agent fought the others for it — measured 401s within 8 seconds of another agent logging in, which produced
 * several false "failures". One account per persona removes that entirely.
 *
 * ROLES ARE MIXED ON PURPOSE: seven admins so the feature personas can exercise everything, one analyst and one
 * viewer so the RBAC boundaries are tested by the personas that actually care about them (P8/P9).
 *
 * Local only. The production database is never touched by this script.
 */
import { db } from '../src/lib/db'
import { hashPassword } from '../src/lib/passwords'

const ORG_ID = 'cmsst1wd20000h8h2k8bp70s4'
const PASSWORD = 'UatPersona2026!'

const ACCOUNTS: Array<{ email: string; name: string; role: 'admin' | 'analyst' | 'viewer'; persona: string }> = [
  { email: 'uat-p1-onboarding@test.local', name: 'P1 First-Run Admin', role: 'admin', persona: 'first-run onboarding' },
  { email: 'uat-p2-rbac@test.local', name: 'P2 RBAC Admin', role: 'admin', persona: 'users and roles' },
  { email: 'uat-p3-sql@test.local', name: 'P3 Sales Analyst', role: 'admin', persona: 'NL to SQL' },
  { email: 'uat-p4-cross@test.local', name: 'P4 Cross-Source Analyst', role: 'admin', persona: 'multi-source routing' },
  { email: 'uat-p5-rag@test.local', name: 'P5 Knowledge Officer', role: 'admin', persona: 'documents and RAG' },
  { email: 'uat-p6-chat@test.local', name: 'P6 Power User', role: 'admin', persona: 'chat UX and state' },
  { email: 'uat-p7-api@test.local', name: 'P7 Integrator', role: 'admin', persona: 'API keys and scoping' },
  { email: 'uat-p8-analyst@test.local', name: 'P8 Analyst (limited)', role: 'analyst', persona: 'RBAC boundary as analyst' },
  { email: 'uat-p9-viewer@test.local', name: 'P9 Viewer (limited)', role: 'viewer', persona: 'RBAC boundary as viewer' },
]

for (const a of ACCOUNTS) {
  const existing = await db.user.findFirst({ where: { email: a.email }, select: { id: true } })
  if (existing) {
    await db.user.update({ where: { id: existing.id }, data: { passwordHash: hashPassword(PASSWORD), isActive: true, role: a.role } })
    console.log(`  updated  ${a.email.padEnd(34)} ${a.role.padEnd(8)} ${a.persona}`)
  } else {
    await db.user.create({
      data: {
        organizationId: ORG_ID, email: a.email, name: a.name, role: a.role,
        passwordHash: hashPassword(PASSWORD), isActive: true, avatarColor: '#6366f1',
      },
    })
    console.log(`  created  ${a.email.padEnd(34)} ${a.role.padEnd(8)} ${a.persona}`)
  }
}
console.log(`\n  password for all nine: ${PASSWORD}`)
await db.$disconnect()
