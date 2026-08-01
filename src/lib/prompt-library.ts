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

export async function getPrompt(id: string): Promise<SavedPrompt | null> {
  return db.savedPrompt.findUnique({ where: { id } })
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
