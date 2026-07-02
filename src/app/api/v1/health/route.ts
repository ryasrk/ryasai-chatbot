import { NextResponse } from 'next/server'
import { publicConfig } from '@/lib/public-config'

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'ryasai',
    version: publicConfig.appVersion,
    time: new Date().toISOString(),
  })
}
