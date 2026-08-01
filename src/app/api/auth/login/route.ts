import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/passwords'
import { signSession } from '@/lib/crypto'
import { writeAudit, handleApiError } from '@/lib/session'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'

/**
 * POST /api/auth/login
 *   Body: { email, password }
 *   - 200 { ok: true, user: { userId, name, email, role } } + httpOnly
 *     `x-active-user` cookie (7-day HMAC-signed session).
 *   - 400 when email/password missing.
 *   - 401 with a GENERIC message on bad credentials (no user enumeration).
 */
export function normalizeLoginInput(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const password = typeof b.password === 'string' ? b.password : ''
  if (!email || !password) return null
  return { email, password }
}

export async function POST(req: NextRequest) {
  try {
    const input = normalizeLoginInput(await req.json().catch(() => null))
    if (!input) {
      return NextResponse.json(
        { error: 'Email and password are required.' },
        { status: 400 },
      )
    }

    // ponytail: login runs before org context exists — bypassOrg for user lookup.
    // findUnique is not scoped by the tenant extension (can't add non-unique fields).
    const user = await bypassOrg(() =>
      db.user.findUnique({
        where: { email: input.email },
        select: { id: true, name: true, email: true, isActive: true, passwordHash: true, role: true, organizationId: true, sessionVersion: true },
      }),
    )
    const ok = !!user && user.isActive && verifyPassword(input.password, user.passwordHash)
    if (!user || !ok) {
      if (user) {
        enterWithOrg(user.organizationId)
        await writeAudit({
          userId: user.id,
          action: 'LOGIN_FAILED',
          severity: 'warning',
          detail: { email: input.email },
        })
      }
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 })
    }

    // Set org context for writeAudit + session increment
    enterWithOrg(user.organizationId)
    await writeAudit({
      userId: user.id,
      action: 'LOGIN_SUCCESS',
      detail: { email: user.email },
    })

    const updated = await db.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    })

    const res = NextResponse.json({
      ok: true,
      user: { userId: user.id, name: user.name, email: user.email, role: user.role },
    })
    res.cookies.set('x-active-user', signSession(user.id, updated.sessionVersion), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })
    return res
  } catch (e) {
    return handleApiError(e, 'Failed to process login.')
  }
}
