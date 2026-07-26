import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/passwords'
import { signSession } from '@/lib/crypto'
import { writeAudit, handleApiError } from '@/lib/session'

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
        { error: 'Email dan password wajib diisi.' },
        { status: 400 },
      )
    }

    const user = await db.user.findUnique({ where: { email: input.email } })
    const ok = !!user && user.isActive && verifyPassword(input.password, user.passwordHash)
    if (!user || !ok) {
      if (user) {
        await writeAudit({
          userId: user.id,
          action: 'LOGIN_FAILED',
          severity: 'warning',
          detail: { email: input.email },
        })
      }
      // Generic message: never reveal whether the email exists.
      return NextResponse.json({ error: 'Email atau password salah.' }, { status: 401 })
    }

    await writeAudit({
      userId: user.id,
      action: 'LOGIN_SUCCESS',
      detail: { email: user.email },
    })

    // ponytail: session fixation defense — increment sessionVersion to invalidate prior cookies.
    const updated = await db.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    })

    const res = NextResponse.json({
      ok: true,
      user: { userId: user.id, name: user.name, email: user.email },
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
    return handleApiError(e, 'Gagal memproses login.')
  }
}
