/**
 * Mint a session cookie for the seeded admin, using the SAME `signSession()` the
 * login route uses (src/lib/crypto.ts), so the measurement goes through the real
 * auth path rather than bypassing it with a test header.
 *
 * Why not POST /api/auth/login: the seeded user's password is not recorded
 * anywhere in the repo, and guessing it would make this harness depend on a
 * secret. Signing the session is the same operation login performs on success.
 */
import { readFileSync } from 'node:fs'
import { signSession } from '../../src/lib/crypto'

const env = readFileSync('.env', 'utf8')
const url = env.match(/^DATABASE_URL=(.*)$/m)![1].trim().replace(/^["']|["']$/g, '')

const { SQL } = await import('bun')
const pg = new SQL(url)
const rows = (await pg.unsafe(
  `SELECT id, email, role, "sessionVersion" FROM "User" WHERE "isActive" = true ORDER BY email LIMIT 1`,
)) as Array<Record<string, unknown>>
await pg.end()
if (!rows.length) throw new Error('no active user to sign a session for')
const u = rows[0]
const token = signSession(String(u.id), Number(u.sessionVersion ?? 0))
console.log(JSON.stringify({ token, userId: u.id, email: u.email, role: u.role }))
