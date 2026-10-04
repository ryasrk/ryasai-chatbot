import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { assertDistinctDatabases, backupPostgres, postgresScalar, restorePostgres } from './postgres-backup'

let directory: string
const originalPath = process.env.PATH
const database = 'postgresql://user:secret@localhost:5432/fixture'
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ryasai-backup-test-'))
  process.env.PATH = `${directory}:${originalPath}`
})
afterEach(async () => {
  process.env.PATH = originalPath
  await rm(directory, { recursive: true, force: true })
})
async function executable(name: string, source: string) {
  const file = join(directory, name)
  await writeFile(file, `#!/usr/bin/env bun\n${source}`)
  await chmod(file, 0o700)
}

describe('PostgreSQL backup transport', () => {
  test('compressed backup keeps literal paths, private permissions and credentials outside argv', async () => {
    await executable('pg_dump', `if (process.argv.join(' ').includes('secret')) process.exit(7); if (!process.env.PGDATABASE) process.exit(8); process.stdout.write('CREATE TABLE "User" (id int);');`)
    const output = join(directory, 'backup $(touch SHOULD_NOT_EXIST) = test.sql.gz')
    expect(await backupPostgres(database, output)).toBeGreaterThan(0)
    expect(gunzipSync(await readFile(output)).toString()).toContain('CREATE TABLE "User"')
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).not.toContain('SHOULD_NOT_EXIST')
  })
  test('a failing dump cannot become a final backup or overwrite a restore point', async () => {
    await executable('pg_dump', `process.stdout.write('PARTIAL'); process.exitCode = 3;`)
    const output = join(directory, 'existing.sql.gz')
    await writeFile(output, 'restore point')
    await expect(backupPostgres(database, output)).rejects.toThrow('pg_dump failed')
    expect(await readFile(output, 'utf8')).toBe('restore point')
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
  test('successful exit with no dump is rejected, even through gzip', async () => {
    await executable('pg_dump', 'process.exit(0)')
    await expect(backupPostgres(database, join(directory, 'empty.sql.gz'))).rejects.toThrow('empty')
    expect(await readdir(directory)).toEqual(['pg_dump'])
  })
  test('restore streams SQL with quoted identifiers and uses a transaction', async () => {
    const received = join(directory, 'received.sql')
    await executable('pg_dump', `process.stdout.write('CREATE TABLE "User" (id int);');`)
    await executable('psql', `if (!process.argv.includes('--single-transaction') || !process.argv.includes('ON_ERROR_STOP=1')) process.exit(9); await Bun.write(${JSON.stringify(received)}, await new Response(Bun.stdin.stream()).text());`)
    const output = join(directory, 'fixture.sql.gz')
    await backupPostgres(database, output)
    await restorePostgres(database, output)
    expect(await readFile(received, 'utf8')).toBe('CREATE TABLE "User" (id int);')
  })
  test('a corrupt compressed dump cannot report a successful restore', async () => {
    await executable('psql', 'await new Response(Bun.stdin.stream()).text();')
    const file = join(directory, 'corrupt.sql.gz')
    await writeFile(file, 'not gzip')
    await expect(restorePostgres(database, file)).rejects.toThrow()
  })
  test('validation passes SQL as one argument and rejects failed queries', async () => {
    await executable('psql', `if (!process.argv.includes('SELECT count(*) FROM "User"')) process.exit(5); process.stdout.write('0\\n');`)
    expect(postgresScalar(database, 'SELECT count(*) FROM "User"')).toBe('0')
    expect(() => postgresScalar(database, 'bad query')).toThrow('validation query failed')
  })
  test('validation cannot target the source database through different credentials', () => {
    expect(() => assertDistinctDatabases(database, 'postgres://other:password@localhost/fixture')).toThrow('separate database')
    expect(() => assertDistinctDatabases(database, 'postgresql://user@localhost/other')).not.toThrow()
  })
})


test('a valid gzip container with no SQL cannot report a successful restore', async () => {
  await executable('psql', 'await new Response(Bun.stdin.stream()).text();')
  const file = join(directory, 'empty-container.sql.gz')
  await writeFile(file, gzipSync(''))
  await expect(restorePostgres(database,file)).rejects.toThrow('empty')
})
