/** The eval organisation's database names, shared by the question builders (importing a builder would run it). */
export const DB_NAME = { chinook: 'Chinook Music Store', erp: 'ERP Demo' } as const

/** Name the database inside the question: a compound question over two databases is ambiguous otherwise. */
export function withDatabase(question: string, ds: 'chinook' | 'erp'): string {
  const name = DB_NAME[ds]
  if (/\bin the database\b/i.test(question)) return question.replace(/\bin the database\b/i, `in the ${name} database`)
  const q = question.trim().replace(/\?+$/, '')
  return `${q} in the ${name} database?`
}
