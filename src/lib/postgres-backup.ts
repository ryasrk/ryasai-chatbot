import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createGzip, createGunzip } from 'node:zlib'
import { randomUUID } from 'node:crypto'

function databaseEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL URL required')
  const schema = url.searchParams.get('schema')
  if (schema && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('Invalid PostgreSQL schema name')
  for (const key of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size']) url.searchParams.delete(key)
  // Use libpq's individual variables: distro pg_wrapper does not reliably
  // forward a URI in PGDATABASE. Credentials remain outside command arguments.
  return { ...process.env,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode')! } : {}),
    ...(url.searchParams.has('sslrootcert') ? { PGSSLROOTCERT: url.searchParams.get('sslrootcert')! } : {}),
    ...(url.searchParams.has('sslcert') ? { PGSSLCERT: url.searchParams.get('sslcert')! } : {}),
    ...(url.searchParams.has('sslkey') ? { PGSSLKEY: url.searchParams.get('sslkey')! } : {}),
    ...(schema ? { PGOPTIONS: `-c search_path=${schema},public` } : {}),
  }
}

function start(command: string, args: string[], databaseUrl: string) {
  const child = spawn(command, args, {
    env: databaseEnv(databaseUrl), stdio: ['pipe', 'pipe', 'pipe'], timeout: 600_000,
  })
  child.stderr.resume()
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error(`${command} could not start`)))
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (exit ${code})`)))
  })
  return { child, completed }
}

export async function backupPostgres(databaseUrl: string, filepath: string): Promise<number> {
  await mkdir(dirname(filepath), { recursive: true, mode: 0o700 })
  const temporary = `${filepath}.${randomUUID()}.tmp`
  const { child, completed } = start('pg_dump', ['--no-owner', '--no-privileges'], databaseUrl)
  child.stdin.end()
  let dumpBytes = 0
  // Count within the pipeline: a data listener can drain before the sink attaches.
  const counter = new Transform({ transform(chunk, _encoding, callback) {
    dumpBytes += chunk.length
    callback(null, chunk)
  } })
  const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
  try {
    const transfer = filepath.endsWith('.gz')
      ? pipeline(child.stdout, counter, createGzip(), output)
      : pipeline(child.stdout, counter, output)
    await Promise.all([completed, transfer])
    const size = (await stat(temporary)).size
    if (!size || !dumpBytes) throw new Error('Database dump is empty')
    await rename(temporary, filepath)
    return size
  } catch (error) {
    child.kill()
    output.destroy()
    await completed.catch(() => {})
    await rm(temporary, { force: true })
    throw error
  }
}

export async function restorePostgres(databaseUrl: string, filepath: string): Promise<void> {
  if (!(await stat(filepath)).size) throw new Error('Database dump is empty')
  const { child, completed } = start('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction'], databaseUrl)
  child.stdout.resume()
  const input = createReadStream(filepath)
  const gunzip = filepath.endsWith('.gz') ? createGunzip() : null
  let sqlBytes = 0
  const counter = new Transform({ transform(chunk, _encoding, callback) {
    sqlBytes += chunk.length
    callback(null, chunk)
  } })
  try {
    const transfer = gunzip
      ? pipeline(input, gunzip, counter, child.stdin)
      : pipeline(input, counter, child.stdin)
    await Promise.all([completed, transfer])
    if (!sqlBytes) throw new Error('Database dump is empty')
  } catch (error) {
    input.destroy()
    child.kill()
    await completed.catch(() => {})
    throw error
  }
}

export function postgresScalar(databaseUrl: string, sql: string): string {
  const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    env: databaseEnv(databaseUrl), encoding: 'utf8', timeout: 30_000,
  })
  if (result.error || result.status !== 0) throw new Error('PostgreSQL validation query failed')
  return result.stdout.trim()
}

export function assertDistinctDatabases(source: string, target: string): void {
  const identity = (value: string) => {
    const url = new URL(value)
    return `${url.hostname.toLowerCase()}:${url.port || '5432'}${decodeURIComponent(url.pathname)}`
  }
  if (identity(source) === identity(target)) throw new Error('Restore validation requires a separate database')
}
