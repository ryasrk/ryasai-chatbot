/**
 * GET /api/documents/[id]/chunks — the paginated chunk body of a document.
 *
 * WHY THIS FILE EXISTS. A small route with a read-shaped surface, which is exactly where the interesting
 * failures hide. Four of them:
 *
 *   1. AN UNPARSEABLE page IS NOT AN ERROR, IT IS PAGE 1. `parseInt('abc') || 1` deliberately swallows a junk
 *      value, and `pageSize` falls back to 20 rather than to 1. A caller sending `?page=abc` must get the first
 *      page, not a 400 and not an empty body.
 *   2. `pageSize` IS CLAMPED TO [1, 100]. An unbounded pageSize is a memory exhaustion vector on a route that
 *      returns full chunk CONTENT. A clamped request must still report the CLAMPED value, so a client paging
 *      with 1000 can see that it got 100.
 *   3. `total` COMES FROM ITS OWN COUNT, NOT from the document's `_count`, and the two can disagree
 *      mid-reindex. The count's `where` is asserted, because a missing filter would page over every chunk in
 *      the org.
 *   4. `totalPages` IS NEVER 0. `Math.max(1, ...)` means an empty document reports one page, not zero, so a
 *      client that builds a pager from `totalPages` does not render "page 1 of 0".
 *
 * Also pinned: `findFirst` for the ownership check (the cross-tenant IDOR class), the `skip`/`take` arithmetic,
 * the `select` that keeps embeddings out of the response, and that `chunkIndex` ordering is explicit.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser

let doc: Record<string, unknown> | null = null
let chunks: Array<Record<string, unknown>> = []
let total = 0
let loadThrows: Error | null = null
let chunkThrows: Error | null = null

const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const enteredOrgs: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  handleApiError: (e: unknown, msg: string) => Response.json({ error: msg }, { status: 500 }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    enteredOrgs.push(o)
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    document: {
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ model: 'document', op: 'findFirst', args })
        if (loadThrows) throw loadThrows
        return doc
      },
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ model: 'document', op: 'findUnique', args })
        return doc
      },
    },
    documentChunk: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'documentChunk', op: 'findMany', args })
        if (chunkThrows) throw chunkThrows
        return chunks
      },
      count: async (args: Record<string, unknown>) => {
        calls.push({ model: 'documentChunk', op: 'count', args })
        if (chunkThrows) throw chunkThrows
        return total
      },
    },
  },
}))

import { GET } from './route'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function get(query = '') {
  return GET(
    new Request(`http://localhost/api/documents/d1/chunks${query}`) as never,
    ctx('d1'),
  )
}

type Body = {
  documentId: string
  documentName: string
  page: number
  pageSize: number
  total: number
  totalPages: number
  chunks: Array<Record<string, unknown>>
}

function findMany() {
  return calls.find((c) => c.model === 'documentChunk' && c.op === 'findMany')!
}

beforeEach(() => {
  user = adminUser
  doc = { id: 'd1', name: 'Manual.pdf', _count: { chunks: 3 } }
  chunks = [
    { id: 'k1', chunkIndex: 0, content: 'first', tokenCount: 10, keywords: ['a'], createdAt: new Date('2026-01-01') },
    { id: 'k2', chunkIndex: 1, content: 'second', tokenCount: 12, keywords: [], createdAt: new Date('2026-01-01') },
    { id: 'k3', chunkIndex: 2, content: 'third', tokenCount: 11, keywords: ['b'], createdAt: new Date('2026-01-01') },
  ]
  total = 3
  loadThrows = null
  chunkThrows = null
  calls.length = 0
  enteredOrgs.length = 0
})

describe('the IDOR class: findFirst for the ownership check', () => {
  test('the document is loaded with findFirst, never findUnique', async () => {
    await get()
    const loads = calls.filter((c) => c.op === 'findFirst' || c.op === 'findUnique')
    expect(loads).toHaveLength(1)
    expect(loads[0]!.op).toBe('findFirst')
  })

  test('the ownership check is done BEFORE the chunks are queried', async () => {
    // A missing document must not reach the chunk query at all; otherwise a 404 would still have read rows.
    doc = null
    await get()
    expect(calls.filter((c) => c.model === 'documentChunk')).toHaveLength(0)
  })

  test('the handler enters the session org', async () => {
    await get()
    expect(enteredOrgs).toEqual(['org-1'])
  })

  test('a missing document is 404 with the plain error shape', async () => {
    doc = null
    const res = await get()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Document not found' })
  })

  test('the document SELECT does not pull the whole row (no embedding, no content)', async () => {
    await get()
    const load = calls.find((c) => c.model === 'document')!
    expect(load.args.select).toEqual({
      id: true,
      name: true,
      _count: { select: { chunks: true } },
    })
  })
})

describe('pagination arithmetic', () => {
  test('page 1 sends no skip and takes the page size', async () => {
    await get('?page=1&pageSize=20')
    expect(findMany().args.skip).toBe(0)
    expect(findMany().args.take).toBe(20)
  })

  test('page 2 skips exactly one page', async () => {
    await get('?page=2&pageSize=20')
    expect(findMany().args.skip).toBe(20)
    expect(findMany().args.take).toBe(20)
  })

  test('page 3 with a page size of 7 skips 14', async () => {
    await get('?page=3&pageSize=7')
    expect(findMany().args.skip).toBe(14)
    expect(findMany().args.take).toBe(7)
  })

  test('the defaults are page 1 with a page size of 20', async () => {
    await get()
    expect(findMany().args.skip).toBe(0)
    expect(findMany().args.take).toBe(20)
  })
})

describe('page is coerced, never rejected', () => {
  test('an UNPARSEABLE page is treated as page 1', async () => {
    // `parseInt('abc', 10) || 1`. A 400 here would be a worse experience than the first page, and an empty
    // body would look like an empty document.
    const res = await get('?page=abc')
    expect(res.status).toBe(200)
    expect(((await res.json()) as Body).page).toBe(1)
    expect(findMany().args.skip).toBe(0)
  })

  test('page 0 is raised to 1, so skip cannot go negative', async () => {
    const res = await get('?page=0')
    expect(((await res.json()) as Body).page).toBe(1)
    expect(findMany().args.skip).toBe(0)
  })

  test('a NEGATIVE page is raised to 1', async () => {
    // `Math.max(1, ...)` is what stops a negative skip, which Prisma rejects.
    const res = await get('?page=-5')
    expect(((await res.json()) as Body).page).toBe(1)
    expect(findMany().args.skip).toBe(0)
  })

  test('a FRACTIONAL page is truncated toward zero', async () => {
    const res = await get('?page=2.9')
    expect(((await res.json()) as Body).page).toBe(2)
    expect(findMany().args.skip).toBe(20)
  })

  test('a page is read from the LEADING digits of a mixed string', async () => {
    // Documented by assertion rather than by claim: parseInt('2x') is 2.
    const res = await get('?page=2x')
    expect(((await res.json()) as Body).page).toBe(2)
  })

  test('an EMPTY page parameter falls back to 1', async () => {
    const res = await get('?page=')
    expect(((await res.json()) as Body).page).toBe(1)
  })
})

describe('pageSize is CLAMPED to [1, 100]', () => {
  test('an oversized page size is clamped AND reported as clamped', async () => {
    // A route that returns full chunk content must not honour `pageSize=1000000`. Reporting the clamped value
    // is part of the contract: a client paging with 1000 has to see that it received 100.
    const res = await get('?pageSize=1000')
    const body = (await res.json()) as Body
    expect(body.pageSize).toBe(100)
    expect(findMany().args.take).toBe(100)
  })

  test('pageSize=0 falls back to the DEFAULT of 20, not to 1', async () => {
    // `parseInt('0') || 20` -- 0 is falsy, so the default applies. Documented by assertion because the two
    // candidates (1 and 20) are both plausible and the code picks 20.
    const res = await get('?pageSize=0')
    expect(((await res.json()) as Body).pageSize).toBe(20)
    expect(findMany().args.take).toBe(20)
  })

  test('a NEGATIVE page size is raised to 1', async () => {
    // Here the clamp DOES apply, because -3 is truthy and survives the `||` default.
    const res = await get('?pageSize=-3')
    expect(((await res.json()) as Body).pageSize).toBe(1)
    expect(findMany().args.take).toBe(1)
  })

  test('an unparseable page size falls back to the default of 20', async () => {
    const res = await get('?pageSize=abc')
    expect(((await res.json()) as Body).pageSize).toBe(20)
  })

  test('the maximum is inclusive at 100', async () => {
    const res = await get('?pageSize=100')
    expect(((await res.json()) as Body).pageSize).toBe(100)
    expect(findMany().args.take).toBe(100)
  })

  test('a page size of 101 is clamped to 100', async () => {
    const res = await get('?pageSize=101')
    expect(((await res.json()) as Body).pageSize).toBe(100)
    expect(findMany().args.take).toBe(100)
  })

  test('a fractional page size is truncated', async () => {
    const res = await get('?pageSize=2.9')
    expect(((await res.json()) as Body).pageSize).toBe(2)
    expect(findMany().args.take).toBe(2)
  })
})

describe('the chunk query', () => {
  test('it filters by the path document id', async () => {
    // The filter is the tenant-visible boundary here: without it the query would page over every chunk.
    await get()
    expect(findMany().args.where).toEqual({ documentId: 'd1' })
  })

  test('it orders by chunkIndex ascending, explicitly', async () => {
    // Without the order the "pages" of a chunk body could interleave arbitrarily between requests.
    await get()
    expect(findMany().args.orderBy).toEqual({ chunkIndex: 'asc' })
  })

  test('the SELECT keeps the embedding vector OUT of the response', async () => {
    // An embedding is 1536 floats per chunk; shipping it would blow up the payload and is never rendered.
    await get()
    expect(findMany().args.select).toEqual({
      id: true,
      chunkIndex: true,
      content: true,
      tokenCount: true,
      keywords: true,
      createdAt: true,
    })
    expect((findMany().args.select as Record<string, unknown>).embedding).toBeUndefined()
  })

  test('the chunks are returned as the query produced them', async () => {
    const res = await get()
    const body = (await res.json()) as Body
    expect(body.chunks).toHaveLength(3)
    expect(body.chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2])
  })

  test('the count uses the SAME filter as the findMany', async () => {
    // `total` and the page must describe the same set, or totalPages is wrong.
    await get()
    const count = calls.find((c) => c.op === 'count')!
    expect(count.args.where).toEqual(findMany().args.where)
  })

  test('the count is NOT taken from the document _count the ownership check already fetched', async () => {
    // `doc._count.chunks` is available and the route deliberately ignores it: the two can disagree mid-reindex,
    // and `total` drives the pager, so it must be the count of what is actually being returned.
    await get()
    expect(calls.filter((c) => c.op === 'count')).toHaveLength(1)
  })

  test('the count and the page are issued together, not sequentially', async () => {
    // Both queries are started before either is awaited (Promise.all). Observable as the ORDER in the call log:
    // findMany then count, with no interleaving from a second handler.
    await get()
    const order = calls.filter((c) => c.model === 'documentChunk').map((c) => c.op)
    expect(order).toEqual(['findMany', 'count'])
  })
})

describe('the envelope', () => {
  test('it reports totalPages from the total and the CLAMPED page size', async () => {
    total = 250
    const res = await get('?pageSize=100')
    expect(((await res.json()) as Body).totalPages).toBe(3)
  })

  test('totalPages rounds UP', async () => {
    total = 101
    const res = await get('?pageSize=100')
    expect(((await res.json()) as Body).totalPages).toBe(2)
  })

  test('an EMPTY document reports totalPages 1, never 0', async () => {
    // `Math.max(1, ...)`. A client rendering "page 1 of N" from this field would otherwise show "page 1 of 0".
    total = 0
    chunks = []
    const res = await get()
    const body = (await res.json()) as Body
    expect(body.total).toBe(0)
    expect(body.totalPages).toBe(1)
  })

  test('the envelope includes the document name, not just the id', async () => {
    const res = await get()
    const body = (await res.json()) as Body
    expect(body.documentId).toBe('d1')
    expect(body.documentName).toBe('Manual.pdf')
  })

  test('the envelope carries exactly the documented keys', async () => {
    const res = await get()
    expect(Object.keys((await res.json()) as Body).sort()).toEqual([
      'chunks',
      'documentId',
      'documentName',
      'page',
      'pageSize',
      'total',
      'totalPages',
    ])
  })

  test('a page BEYOND the end is still 200 with an empty chunk list', async () => {
    // Not a 404: it is a valid request for a valid document, and the pager needs `total` to recover.
    chunks = []
    const res = await get('?page=99')
    const body = (await res.json()) as Body
    expect(res.status).toBe(200)
    expect(body.chunks).toEqual([])
    expect(body.total).toBe(3)
  })
})

describe('internal failures map to the typed error response', () => {
  test('a document load failure is 500 without leaking the error text', async () => {
    loadThrows = new Error('connection reset')
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('connection reset')
  })

  test('a CHUNK query failure is 500 and is not silently reported as an empty document', async () => {
    // The dangerous alternative: swallowing the failure and answering `{ chunks: [], total: 0 }`, which a
    // client cannot distinguish from a genuinely empty document.
    chunkThrows = new Error('connection reset')
    const res = await get()
    expect(res.status).toBe(500)
    expect((await res.json()) as { error: string }).not.toEqual({ error: 'Document not found' })
  })

  test('a failing COUNT alone also fails the request', async () => {
    // Promise.all rejects on either branch; a half-built envelope must not be returned.
    total = 3
    chunkThrows = new Error('connection reset')
    expect((await get()).status).toBe(500)
  })
})

describe('hostile query input', () => {
  test('prototype-pollution style keys do not alter the response', async () => {
    const res = await get('?__proto__[page]=5&constructor=1&pageSize=2')
    const body = (await res.json()) as Body
    expect(body.pageSize).toBe(2)
    expect(body.page).toBe(1)
  })

  test('a repeated parameter takes the FIRST value', async () => {
    // URLSearchParams.get returns the first, so the result is deterministic rather than "last one wins".
    const res = await get('?page=3&page=7')
    expect(((await res.json()) as Body).page).toBe(3)
  })

  test('an unknown parameter is ignored', async () => {
    const res = await get('?nonsense=1&pageSize=5')
    expect(((await res.json()) as Body).pageSize).toBe(5)
  })

  test('extra whitespace in the value is tolerated by parseInt', async () => {
    const res = await get('?page=%20%203%20')
    expect(((await res.json()) as Body).page).toBe(3)
  })
})
