import { NextResponse } from 'next/server'
import { prometheusText, initMetrics } from '@/lib/metrics'

initMetrics()

export const dynamic = 'force-dynamic'

export async function GET() {
  const body = prometheusText()
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
