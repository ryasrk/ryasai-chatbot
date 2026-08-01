import { PrismaClient } from '@prisma/client'
import { serverConfig } from '@/lib/config'
import { createTenantExtension } from '@/lib/prisma-tenant'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const baseClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    // ponytail: logging every query (incl. params) is noisy + leaks data.
    // Enable explicitly via DB_QUERY_LOG=true.
    log: serverConfig.dbQueryLog ? ['query'] : ['error'],
  })

// ponytail: tenant extension auto-injects organizationId via AsyncLocalStorage.
// Routes that call getActiveUser() get org-scoping for free. bypassOrg() for
// setup/SSO where no org context exists.
export const db = baseClient.$extends(createTenantExtension())

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = baseClient

export function isPrismaNotFound(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025'
}
