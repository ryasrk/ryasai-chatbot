export type DbProvider = 'sqlite' | 'postgresql'

export function getDbProvider(): DbProvider {
  const url = process.env.DATABASE_URL ?? ''
  return url.startsWith('postgresql://') || url.startsWith('postgres://') ? 'postgresql' : 'sqlite'
}
