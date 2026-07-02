import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

/**
 * GET /api/me
 *   Returns the active user { userId, companyId, role, name, email } plus
 *   the company name. Returns 401 when no valid session is present so the
 *   client shell can render the login screen.
 *
 * (Multi-user switching was removed; this product has a single admin.)
 */

export async function GET() {
  try {
    const user = await getActiveUser()
    const company = await db.company.findUnique({
      where: { id: user.companyId },
      select: { name: true },
    })

    return NextResponse.json({ ...user, companyName: company?.name ?? null })
  } catch (err) {
    return handleApiError(err, 'Gagal memuat data pengguna aktif.')
  }
}
