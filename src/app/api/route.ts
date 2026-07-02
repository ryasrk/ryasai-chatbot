import { NextResponse } from 'next/server'
import { publicConfig } from '@/lib/public-config'

/**
 * GET /api
 * Lightweight health/info endpoint (replaces the old "Hello, world!" placeholder).
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'ryasai',
    version: publicConfig.appVersion,
    time: new Date().toISOString(),
  })
}
