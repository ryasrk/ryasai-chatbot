import { NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'

export async function GET() {
  try {
    const user = await getActiveUser()
    return NextResponse.json(user)
  } catch (err) {
    return handleApiError(err, 'Gagal memuat data pengguna aktif.')
  }
}
