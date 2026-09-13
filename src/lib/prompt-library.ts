import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'
import type { SavedPrompt } from '@prisma/client'

export interface PromptInput {
  title: string
  content: string
  category?: string
  isPublic?: boolean
}

export async function createPrompt(userId: string, input: PromptInput): Promise<SavedPrompt> {
  return db.savedPrompt.create({
    data: {
      organizationId: getOrgContext()!,
      userId,
      title: input.title,
      content: input.content,
      category: input.category ?? 'general',
      isPublic: input.isPublic ?? false,
    },
  })
}

/**
 * Load one saved prompt BY ID, scoped to the active organization.
 *
 * MUST be `findFirst`. `findUnique` is the one read the tenant extension cannot rewrite -- its where-clause is
 * used verbatim -- so `db.savedPrompt.findUnique({ where: { id } })` returned the row for ANY organization id,
 * and `GET /api/prompts` hands every prompt id to the browser. A member of one tenant could therefore read,
 * rewrite or delete another tenant saved prompts by pasting an id.
 *
 * This also slipped past BOTH static guards, which is worth knowing. `tenant-route-guard.test.ts` passes because
 * the route does call `enterWithOrg`, and the findUnique check in `invariants.test.ts` globs only files inside
 * `src/app/api` whose name is `route.ts` -- the offending call sat one level down in `src/lib`. Scoping the read
 * here is what makes those guards' assumptions true, rather than the route-level guard being the only barrier.
 */
export async function getPrompt(id: string): Promise<SavedPrompt | null> {
  return db.savedPrompt.findFirst({ where: { id } })
}

export async function listPrompts(filter: {
  userId?: string
  category?: string
  isPublic?: boolean
}): Promise<SavedPrompt[]> {
  const where: Record<string, unknown> = {}
  if (filter.userId) where.userId = filter.userId
  if (filter.category) where.category = filter.category
  if (typeof filter.isPublic === 'boolean') where.isPublic = filter.isPublic
  return db.savedPrompt.findMany({ where, orderBy: { createdAt: 'desc' } })
}

export async function updatePrompt(
  id: string,
  patch: Partial<PromptInput>,
): Promise<SavedPrompt> {
  const data: Record<string, unknown> = {}
  if (typeof patch.title === 'string') data.title = patch.title
  if (typeof patch.content === 'string') data.content = patch.content
  if (typeof patch.category === 'string') data.category = patch.category
  if (typeof patch.isPublic === 'boolean') data.isPublic = patch.isPublic
  return db.savedPrompt.update({ where: { id }, data })
}

export async function deletePrompt(id: string): Promise<void> {
  await db.savedPrompt.delete({ where: { id } })
}
