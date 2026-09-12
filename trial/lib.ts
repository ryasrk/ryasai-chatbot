/**
 * Shared trial helpers.
 *
 * ponytail: this harness measures RETRIEVAL and ROUTING, never answer text.
 * The local LLM is a mock, so any "quality" score it produced would be scoring
 * the mock. Everything below is computed from real Postgres + real embeddings +
 * the real scoring functions, which is why it can run without a real model.
 */
import { db } from '../src/lib/db'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'

export interface TrialContext {
  organizationId: string
  userId: string
}

/** Create an isolated org so trial data never mixes with dev fixtures. */
export async function createTrialOrg(slug: string, plan = 'flat'): Promise<TrialContext> {
  const org = await bypassOrg(() =>
    db.organization.create({
      data: {
        name: `Trial ${slug}`,
        slug,
        licenseStatus: 'valid',
        licensePlan: plan,
        licenseValidatedAt: new Date(),
      },
      select: { id: true },
    }),
  )
  const user = await bypassOrg(() =>
    db.user.create({
      data: {
        organizationId: org.id,
        email: `trial-${slug}@trial.local`,
        name: 'Trial Admin',
        passwordHash: '!',
        role: 'admin',
        sessionVersion: 1,
      },
      select: { id: true },
    }),
  )
  return { organizationId: org.id, userId: user.id }
}

export async function dropTrialOrg(organizationId: string): Promise<void> {
  await bypassOrg(() => db.organization.delete({ where: { id: organizationId } }))
}

/** Run a body inside the org's tenant context, the way a route handler does. */
export async function inOrg<T>(ctx: TrialContext, fn: () => Promise<T>): Promise<T> {
  return bypassOrg(async () => {
    enterWithOrg(ctx.organizationId)
    return fn()
  })
}

export function pct(n: number, d: number): string {
  if (d === 0) return 'n/a'
  return `${((n / d) * 100).toFixed(1)}%`
}

export function hr(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
}
