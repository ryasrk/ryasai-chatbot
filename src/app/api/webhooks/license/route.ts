import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { handleApiError } from '@/lib/session'
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('license-webhook')

/**
 * POST /api/webhooks/license
 *   Receives license status updates from the License-Validator service.
 *   Body: { license_key: string, event: 'revoked' | 'expired' | 'reactivated' | 'updated', plan?: string }
 *   Protected by LICENSE_WEBHOOK_SECRET header check.
 *
 *   This route is public (no session cookie) but protected by a shared secret
 *   in the x-webhook-secret header. Add '/api/webhooks/license' to PUBLIC_API_PATHS
 *   in middleware if it's not already covered by the '/api/webhooks/' prefix.
 */
export async function POST(req: NextRequest) {
  try {
    const webhookSecret = req.headers.get('x-webhook-secret')
    const expectedSecret = process.env.LICENSE_WEBHOOK_SECRET

    if (!expectedSecret || webhookSecret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }

    const { license_key, event, plan } = body as { license_key?: string; event?: string; plan?: string }
    if (!license_key || !event) {
      return NextResponse.json({ error: 'license_key and event required' }, { status: 400 })
    }

    const org = await bypassOrg(() =>
      db.organization.findFirst({
        where: { licenseKey: license_key },
        select: { id: true },
      }),
    )
    if (!org) {
      return NextResponse.json({ ok: true, message: 'Organization not found for this license key.' })
    }

    let status: string
    switch (event) {
      case 'revoked':
      case 'expired':
        status = 'expired'
        break
      case 'suspended':
        status = 'suspended'
        break
      case 'reactivated':
      case 'updated':
        status = 'valid'
        break
      default:
        return NextResponse.json({ error: `Unknown event: ${event}` }, { status: 400 })
    }

    await bypassOrg(() =>
      db.organization.update({
        where: { id: org.id },
        data: {
          licenseStatus: status,
          ...(plan ? { licensePlan: plan } : {}),
          licenseValidatedAt: new Date(),
        },
      }),
    )

    log.info('License webhook processed', { license_key, event, orgId: org.id, newStatus: status })
    return NextResponse.json({ ok: true, status })
  } catch (e) {
    return handleApiError(e, 'License webhook failed.')
  }
}
