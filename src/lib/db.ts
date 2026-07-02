import { PrismaClient } from '@prisma/client'
import { serverConfig } from '@/lib/config'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // ponytail: logging every query (incl. params) is noisy + leaks data.
    // Enable explicitly via DB_QUERY_LOG=true.
    log: serverConfig.dbQueryLog ? ['query'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db