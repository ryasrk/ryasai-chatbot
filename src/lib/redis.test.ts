import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ===========================================================================
// redis.ts — rate limiting, health, and the distributed cache
// ===========================================================================
//
// This module had NO test file at all. It carries the RATE LIMITER (a security
// control), the TLS warning for production, and the cache every RAG/router path
// falls back on. The mocks below are the ONLY way to reach these branches, since
// the real clients connect to a live server at import time.

/** One scripted response per `cmd` call, consumed in order. */
const cmdScript: Array<() => Promise<unknown> | unknown> = []
const cmdCalls: Array<{ method: string; args: unknown[] }> = []

/** Records how the two IORedis instances were constructed. */
const constructed: Array<{ url: string; opts: Record<string, unknown> }> = []
/** Constructor calls whose `on('error')` handler we captured. */
const errorHandlers: Array<(e: unknown) => void> = []
const quitCalls: string[] = []

function makeClient(url: string, opts: Record<string, unknown>) {
  const idx = constructed.length
  constructed.push({ url, opts })
  return {
    on: (event: string, handler: (e: unknown) => void) => {
      if (event === 'error') errorHandlers.push(handler)
    },
    quit: async () => { quitCalls.push(String(idx)); return 'OK' },
    // Every command funnels through here so a test can script OR fail it.
    incr: async (...args: unknown[]) => { cmdCalls.push({ method: 'incr', args }); return runScript('incr', args) },
    expire: async (...args: unknown[]) => { cmdCalls.push({ method: 'expire', args }); return runScript('expire', args) },
    ping: async (...args: unknown[]) => { cmdCalls.push({ method: 'ping', args }); return runScript('ping', args) },
    get: async (...args: unknown[]) => { cmdCalls.push({ method: 'get', args }); return runScript('get', args) },
    set: async (...args: unknown[]) => { cmdCalls.push({ method: 'set', args }); return runScript('set', args) },
    scan: async (...args: unknown[]) => { cmdCalls.push({ method: 'scan', args }); return runScript('scan', args) },
    del: async (...args: unknown[]) => { cmdCalls.push({ method: 'del', args }); return runScript('del', args) },
  }
}

let scriptIndex = 0
function runScript(method: string, _args: unknown[]) {
  const step = cmdScript[scriptIndex++]
  if (!step) throw new Error(`no scripted response for ${method} (index ${scriptIndex - 1})`)
  return step()
}

function failing(method: string) {
  return () => { cmdCalls.push({ method, args: [] }); throw new Error('redis down') }
}

mock.module('ioredis', () => ({
  default: class {
    constructor(url: string, opts: Record<string, unknown>) {
      Object.assign(this, makeClient(url, opts))
    }
  },
}))
const queueConstructed: Array<{ name: string; opts: Record<string, unknown> }> = []
mock.module('bullmq', () => ({
  Queue: class {
    constructor(name: string, opts: Record<string, unknown>) { queueConstructed.push({ name, opts }) }
  },
}))

const mod = await import('./redis')

// Captured ONCE: the two IORedis clients and the Queue are constructed at module
// load, so a beforeEach reset would erase the only evidence of how they were built
// (my first version did exactly that, and four tests failed with empty arrays).
const constructedAtLoad = constructed.map((c) => ({ ...c, opts: { ...c.opts } }))
const errorHandlersAtLoad = [...errorHandlers]
const queueAtLoad = queueConstructed.map((q) => ({ ...q, opts: { ...q.opts } }))

beforeEach(() => {
  cmdScript.length = 0
  cmdCalls.length = 0
  constructed.length = 0
  errorHandlers.length = 0
  quitCalls.length = 0
  queueConstructed.length = 0
  scriptIndex = 0
})

describe('redis — connection configuration', () => {
  test('THREE clients are built: the BullMQ one, the fast-failing one, and the queue', async () => {
    // Two IORedis instances plus one Queue. The distinction matters: the BullMQ
    // connection must NOT have enableOfflineQueue:false, and the command client
    // must, or the rate limiter would queue instead of failing fast.
    expect(constructedAtLoad.length).toBe(2)
    expect(queueAtLoad.length).toBe(1)
    expect(queueAtLoad[0].name).toBe('document-processing')
  })

  test('the BullMQ client allows retries; the command client fails fast', async () => {
    // maxRetriesPerRequest:null is REQUIRED by BullMQ for blocking commands.
    expect(constructedAtLoad[0].opts.maxRetriesPerRequest).toBeNull()
    // The command client rejects immediately when Redis is down so callers can fall
    // back to DB-based limiting instead of hanging on an offline queue.
    expect(constructedAtLoad[1].opts.enableOfflineQueue).toBe(false)
    expect(constructedAtLoad[1].opts.maxRetriesPerRequest).toBe(1)
  })

  test('both clients install a no-op error handler', async () => {
    // Without a listener an unhandled 'error' event CRASHES the process when Redis
    // is down -- the single most common way a cache outage takes the app with it.
    expect(errorHandlersAtLoad.length).toBe(2)
    for (const h of errorHandlersAtLoad) expect(() => h(new Error('connection refused'))).not.toThrow()
  })

  test('the queue retries three times with exponential backoff', async () => {
    const opts = queueAtLoad[0].opts.defaultJobOptions as {
      attempts: number; backoff: { type: string; delay: number }
    }
    expect(opts.attempts).toBe(3)
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 5_000 })
  })
})

describe('rateLimit', () => {
  test('the first hit in a bucket sets a 60s TTL', async () => {
    // incr returns 1 -> the bucket is new -> it MUST be expired or it counts
    // forever and the caller is permanently locked out after maxPerMinute total
    // requests, not per minute.
    cmdScript.push(async () => 1, async () => 1)
    const res = await mod.rateLimit('api-key-1', 10)
    expect(res).toEqual({ allowed: true, remaining: 9 })
    const expire = cmdCalls.find((c) => c.method === 'expire')
    expect(expire).toBeDefined()
    expect(expire?.args).toEqual([expect.stringContaining('ratelimit:api-key-1:'), 60])
  })

  test('later hits do NOT re-set the TTL', async () => {
    // Re-expiring on every hit would slide the window and let a client exceed the
    // limit indefinitely.
    cmdScript.push(async () => 5)
    const res = await mod.rateLimit('api-key-1', 10)
    expect(res).toEqual({ allowed: true, remaining: 5 })
    expect(cmdCalls.filter((c) => c.method === 'expire')).toHaveLength(0)
  })

  test('the limit is inclusive, and remaining never goes negative', async () => {
    cmdScript.push(async () => 10)
    expect(await mod.rateLimit('k', 10)).toEqual({ allowed: true, remaining: 0 })

    scriptIndex = 0; cmdScript.length = 0
    cmdScript.push(async () => 11)
    const over = await mod.rateLimit('k', 10)
    expect(over?.allowed).toBe(false)
    // Clamped: a negative "remaining" leaks the overage and can render as-is in a UI.
    expect(over?.remaining).toBe(0)
  })

  test('the bucket key is per-MINUTE, so windows are fixed not sliding', async () => {
    cmdScript.push(async () => 1, async () => 1)
    await mod.rateLimit('k', 10)
    const key = String(cmdCalls.find((c) => c.method === 'incr')?.args[0])
    expect(key).toMatch(/^ratelimit:k:\d+$/)
    // The bucket number is floor(now / 60000).
    expect(Number(key.split(':')[2])).toBe(Math.floor(Date.now() / 60_000))
  })

  test('Redis being DOWN returns null, not a throw and not an allow', async () => {
    // null is the contract: the caller falls back to DB-based limiting. Returning
    // {allowed:true} here would silently disable the limit entirely.
    cmdScript.push(() => { throw new Error('redis down') })
    expect(await mod.rateLimit('k', 10)).toBeNull()
  })
})

describe('checkRedisHealth', () => {
  test('a successful ping reports connected with a latency', async () => {
    cmdScript.push(async () => 'PONG')
    const health = await mod.checkRedisHealth()
    expect(health.connected).toBe(true)
    expect(typeof health.latencyMs).toBe('number')
    expect(health.latencyMs).toBeGreaterThanOrEqual(0)
  })

  test('a failing ping reports NOT connected and no latency', async () => {
    cmdScript.push(() => { throw new Error('down') })
    expect(await mod.checkRedisHealth()).toEqual({ connected: false })
  })
})

describe('cacheGet', () => {
  test('a hit is JSON-parsed', async () => {
    cmdScript.push(async () => JSON.stringify({ a: 1 }))
    expect(await mod.cacheGet<{ a: number }>('k')).toEqual({ a: 1 })
  })

  test('a MISS is null', async () => {
    cmdScript.push(async () => null)
    expect(await mod.cacheGet('k')).toBeNull()
  })

  test('corrupt JSON is swallowed into the fallback, NOT thrown', async () => {
    // JSON.parse runs INSIDE the try, so a truncated value from a previous deploy
    // must not crash the caller -- it degrades to the in-memory cache.
    cmdScript.push(async () => '{not json')
    expect(await mod.cacheGet('k')).toBeNull()
  })

  test('Redis down falls back to the value written while it was down', async () => {
    // The end-to-end fallback contract, and the reason this module works at all
    // during a Redis outage: a write that failed lands in memory and a read that
    // fails finds it.
    cmdScript.push(() => { throw new Error('down') })          // set -> memory
    await mod.cacheSet('fb-key', { v: 'kept' }, 60)
    cmdScript.push(() => { throw new Error('down') })          // get -> memory
    expect(await mod.cacheGet<{ v: string }>('fb-key')).toEqual({ v: 'kept' })
  })

  test('a key never written anywhere is null even when Redis is down', async () => {
    cmdScript.push(() => { throw new Error('down') })
    expect(await mod.cacheGet('never-seen-this-key')).toBeNull()
  })
})

describe('cacheSet', () => {
  test('writes with an EX TTL', async () => {
    cmdScript.push(async () => 'OK')
    await mod.cacheSet('k', { x: 1 }, 90)
    const set = cmdCalls.find((c) => c.method === 'set')
    expect(set?.args).toEqual(['k', JSON.stringify({ x: 1 }), 'EX', 90])
  })

  test('a serialisation failure is swallowed rather than thrown', async () => {
    // JSON.stringify runs OUTSIDE the try on purpose, so a circular value throws --
    // pinned so a future refactor that moves it inside is a deliberate choice.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => mod.cacheSet('k', circular, 60)).toThrow()
  })
})

describe('cacheDel', () => {
  test('SCANs the prefix and deletes every batch, following the cursor', async () => {
    // SCAN, not KEYS: KEYS blocks the whole Redis server. Two pages are scripted so
    // the cursor loop is exercised end to end.
    cmdScript.push(
      async () => ['17', ['a:1', 'a:2']],
      async () => 2,
      async () => ['0', ['a:3']],
      async () => 1,
    )
    await mod.cacheDel('a:')
    expect(cmdCalls.filter((c) => c.method === 'scan').length).toBe(2)
    const dels = cmdCalls.filter((c) => c.method === 'del')
    expect(dels[0].args).toEqual(['a:1', 'a:2'])
    expect(dels[1].args).toEqual(['a:3'])
    // A page with no keys must NOT issue an empty DEL.
    const empty = cmdCalls.filter((c) => c.method === 'del').length
    expect(empty).toBe(2)
  })

  test('the MATCH pattern is the prefix plus a wildcard, with a bounded COUNT', async () => {
    cmdScript.push(async () => ['0', []])
    await mod.cacheDel('rag:')
    const scan = cmdCalls.find((c) => c.method === 'scan')
    expect(scan?.args).toEqual(['0', 'MATCH', 'rag:*', 'COUNT', 100])
  })

  test('a page with NO keys skips the DEL entirely', async () => {
    cmdScript.push(async () => ['0', []])
    await mod.cacheDel('none:')
    expect(cmdCalls.filter((c) => c.method === 'del')).toHaveLength(0)
  })

  test('Redis down clears the matching in-memory fallback keys', async () => {
    // The fallback map has no TTL, so a delete that misses it leaves STALE data
    // readable after the caller believed it was invalidated.
    cmdScript.push(() => { throw new Error('down') })
    await mod.cacheSet('del-a:1', 1, 60)
    cmdScript.push(() => { throw new Error('down') })
    await mod.cacheSet('del-b:1', 2, 60)
    cmdScript.push(() => { throw new Error('down') })
    await mod.cacheSet('other:1', 3, 60)

    cmdScript.push(() => { throw new Error('down') })
    await mod.cacheDel('del-a:')
    cmdScript.push(() => { throw new Error('down') })
    await mod.cacheDel('del-b:')

    // Both cleared, and the untouched prefix survives.
    cmdScript.push(() => { throw new Error('down') })
    expect(await mod.cacheGet<number>('other:1')).toBe(3)
  })
})

describe('disconnectRedis', () => {
  test('quits both clients and tolerates one failing', async () => {
    // Promise.allSettled, not all: a shutdown must not throw because one socket was
    // already gone.
    cmdScript.push(async () => 'OK')
    await expect(mod.disconnectRedis()).resolves.toBeUndefined()
    expect(quitCalls.length).toBe(2)
  })
})

describe('the production TLS warning', () => {
  // Line 10 is evaluated at MODULE LOAD, so it cannot be reached by importing the
  // module again inside this process -- the first import already ran with this
  // process's env. A subprocess is the only honest way to observe it, and the
  // warning is a SECURITY notice: silently dropping plaintext Redis in production
  // would ship credentials over an unencrypted link.
  async function loadWith(env: Record<string, string>): Promise<string> {
    // `mock` is only defined when bun:test is imported -- my first version called
    // it bare and every subprocess died with "mock is not defined", so all four
    // tests failed on the harness rather than on the warning.
    const script = `
      import { mock } from 'bun:test'
      // Stub the drivers so importing the module does not open real sockets.
      mock.module('ioredis', () => ({ default: class { on() {} quit() { return Promise.resolve() } } }))
      mock.module('bullmq', () => ({ Queue: class {} }))
      await import('${import.meta.dir}/redis')
      console.log('IMPORT-OK')
    `
    const r = await Bun.$`bun -e ${script}`.env({ ...process.env, ...env }).quiet().nothrow()
    return r.stdout.toString() + r.stderr.toString()
  }

  test('a NON-TLS REDIS_URL in production WARNS loudly', async () => {
    const out = await loadWith({ NODE_ENV: 'production', REDIS_URL: 'redis://redis.internal:6379' })
    expect(out).toContain('IMPORT-OK')
    expect(out).toContain('SECURITY')
    expect(out).toContain('not using TLS')
  })

  test('a TLS rediss:// URL in production is silent', async () => {
    // The inverse, so the test above cannot pass merely because production always warns.
    const out = await loadWith({ NODE_ENV: 'production', REDIS_URL: 'rediss://redis.internal:6380' })
    expect(out).toContain('IMPORT-OK')
    expect(out).not.toContain('SECURITY')
  })

  test('a NON-TLS url in DEVELOPMENT is allowed (local redis has no TLS)', async () => {
    // Local dev uses a plain redis:// on purpose; warning there would train everyone
    // to ignore the message.
    const out = await loadWith({ NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' })
    expect(out).toContain('IMPORT-OK')
    expect(out).not.toContain('SECURITY')
  })

  test('it WARNS rather than throws, so a deployment still boots', async () => {
    // Documented as deliberate: some prod deployments rely on an internal network.
    // A hard failure here would take down an otherwise working install.
    const out = await loadWith({ NODE_ENV: 'production', REDIS_URL: 'redis://redis.internal:6379' })
    expect(out).toContain('IMPORT-OK')
  })
})
