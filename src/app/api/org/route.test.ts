/**
 * GET + PATCH /api/org — the current tenant's own record.
 *
 * WHY THIS FILE EXISTS. This is the one route that answers "which organization am I", so a bug here is either a
 * cross-tenant read or a cross-tenant write. Four properties:
 *
 *   1. THE ID IS ALWAYS THE SESSION ORG, NEVER REQUEST INPUT. Neither handler accepts an id from the body or the
 *      query string, and both filter by `user.organizationId`. Asserted on the ARGUMENTS of every DB call, because
 *      a happy-path test cannot tell the difference between `where: { id: sessionOrg }` and a hardcoded id.
 *   2. THE READ GOES THROUGH `bypassOrg` WITH AN EXPLICIT ID. `Organization` is not an org-scoped model (it IS the
 *      org layer), so the tenant extension would not help here even if the route forgot the bypass -- the explicit
 *      `where: { id }` is the ONLY scoping. That is why the id is asserted rather than the returned row.
 *   3. `findUnique` IS CORRECT HERE, and this file records WHY so nobody "fixes" it into findFirst or (worse)
 *      reasons from it that findUnique-on-a-client-id is fine. The row is the session's OWN org and the id is not
 *      client-supplied. `src/lib/invariants.test.ts` carries this file on its findUnique allowlist; the reasoning
 *      is reproduced here so the allowlist entry does not look like an oversight. There is no IDOR: an attacker
 *      cannot choose the id, and a body-supplied `id` is ignored outright (pinned below).
 *   4. PATCH IS ADMIN-GATED *AFTER* THE ORG CONTEXT IS ENTERED, and every write is audited with the FIELD NAMES
 *      only. A partial update must never blank a column it did not mention, and an empty body must be a 400 rather
 *      than a no-op UPDATE that still writes an audit row.
 *
 * Control tests were verified by mutating the route in place, running the file, and restoring it; each test names
 * the mutation that was proven to bite.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// ---- mutable seams, declared before every mock.module ----
const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser
let orgRow: Record<string, unknown> | null = {
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  brandingJson: null,
  licensePlan: 'flat',
  licenseStatus: 'valid',
  licenseExpiresAt: null,
}
let updateRow: Record<string, unknown> | null = { id: 'org-1', name: 'Renamed' }
let findThrows: Error | null = null
let updateThrows: Error | null = null
let requireRoleThrows: Error | null = null
const findQueries: Array<Record<string, unknown>> = []
const updateQueries: Array<Record<string, unknown>> = []
const audits: Array<Record<string, unknown>> = []
const events: string[] = []
let handleErrorArgs: Array<{ fallback: string; status: number | undefined }> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  requireRole: (u: typeof adminUser, minRole: string) => {
    events.push(`requireRole:${minRole}`)
    if (requireRoleThrows) throw requireRoleThrows
    if (({ viewer: 0, analyst: 1, admin: 2 } as Record<string, number>)[u.role]! < ({ viewer: 0, analyst: 1, admin: 2 } as Record<string, number>)[minRole]!) {
      throw Object.assign(new Error(`Requires ${minRole} role. You have ${u.role}.`), { name: 'ForbiddenError', code: 'FORBIDDEN' })
    }
  },
  writeAudit: async (row: Record<string, unknown>) => {
    events.push('writeAudit')
    audits.push(row)
  },
  // Mirrors the real mapper's CLASS-based branching, so a ForbiddenError is a 403 with FORBIDDEN -- not a 500.
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    events.push('handleApiError')
    handleErrorArgs.push({ fallback, status })
    const name = (e as { name?: string } | null)?.name
    if (name === 'ForbiddenError') {
      return Response.json({ error: { code: 'FORBIDDEN', message: (e as Error).message } }, { status: 403 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    events.push(`enterWithOrg:${orgId}`)
  },
  bypassOrg: async (fn: () => Promise<unknown>) => {
    events.push('bypassOrg')
    return fn()
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    organization: {
      findUnique: async (args: Record<string, unknown>) => {
        findQueries.push(args)
        events.push('organization.findUnique')
        if (findThrows) throw findThrows
        return orgRow
      },
      update: async (args: Record<string, unknown>) => {
        updateQueries.push(args)
        events.push('organization.update')
        if (updateThrows) throw updateThrows
        return updateRow
      },
    },
  },
}))

// DYNAMIC: mock.module does not apply to static imports.
const { GET, PATCH } = await import('./route')

function patch(body: unknown) {
  const req = new Request('http://localhost/api/org', {
    method: 'PATCH',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as Request & { nextUrl: URL }
  req.nextUrl = new URL('http://localhost/api/org')
  return PATCH(req as never)
}

/** The ORG_SELECT contract, spelled out once so both handlers are checked against the same list. */
const ORG_SELECT_KEYS = [
  'brandingJson',
  'id',
  'licenseExpiresAt',
  'licensePlan',
  'licenseStatus',
  'name',
  'slug',
]

beforeEach(() => {
  user = adminUser
  orgRow = {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    brandingJson: null,
    licensePlan: 'flat',
    licenseStatus: 'valid',
    licenseExpiresAt: null,
  }
  updateRow = { id: 'org-1', name: 'Renamed' }
  findThrows = null
  updateThrows = null
  requireRoleThrows = null
  findQueries.length = 0
  updateQueries.length = 0
  audits.length = 0
  events.length = 0
  handleErrorArgs = []
})

describe('GET', () => {
  test('it returns the org under ok:true', async () => {
    const body = (await (await GET()).json()) as { ok: boolean; organization: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.organization.id).toBe('org-1')
  })

  test('the read is scoped BY THE SESSION ORG ID, through the bypass', async () => {
    // Control C1 (changing `where: { id: user.organizationId }` to `where: {}`): red. Organization is not an
    // org-scoped model, so this explicit id is the ONLY thing standing between a tenant and another tenant row.
    await GET()
    expect(findQueries[0]!.where).toEqual({ id: 'org-1' })
  })

  test('the id follows the session and is NOT a constant', async () => {
    user = { ...adminUser, organizationId: 'org-other' }
    await GET()
    expect(findQueries[0]!.where).toEqual({ id: 'org-other' })
    expect(events[0]).toBe('enterWithOrg:org-other')
  })

  test('the SELECT is the exact seven-column contract — no licenseKey, no createdAt', async () => {
    // Control C2 (dropping the select so the whole row spreads): red. `licenseKey` is a live entitlement secret
    // and `createdAt`/`updatedAt` are internal; both would ship on every page load.
    await GET()
    const select = findQueries[0]!.select as Record<string, unknown>
    expect(Object.keys(select).sort()).toEqual(ORG_SELECT_KEYS)
    expect(select.licenseKey).toBeUndefined()
    expect(select.createdAt).toBeUndefined()
  })

  test('the handler adds NO field of its own: the response is the selected row, verbatim', async () => {
    // Recorded precisely, because my first version of this test was WRONG and worth keeping as a lesson: the
    // handler is `NextResponse.json({ ok: true, organization })` with no spread and no redaction of its own, so
    // if the select ever widened, the widened columns would ship. With the real seven-column select in place the
    // response body is a byte-for-byte serialisation of those seven fields -- asserted here against a row object
    // carrying ONLY them, which is what Prisma would return.
    const body = (await (await GET()).json()) as { organization: Record<string, unknown> }
    expect(Object.keys(body.organization).sort()).toEqual(ORG_SELECT_KEYS)
    expect(JSON.stringify(body.organization)).toBe(JSON.stringify(orgRow))
  })

  test('a column OUTSIDE the select reaches the client only if the select widens — the handler is the only guard', async () => {
    // DECLARED NON-CONTROL for the route as written, and the negative half of the test above. Because the handler
    // forwards the query result untouched, this seam cannot prove the select is narrow: it proves the OPPOSITE --
    // that widening the select would leak. `licenseKey` is a live entitlement secret, so it is the column to watch
    // (the sibling route /api/org/license selects it deliberately, for admins, and this route must not).
    orgRow = { ...orgRow, licenseKey: 'RYASAI-SECRET-KEY' }
    const t = await (await GET()).text()
    expect(t).toContain('RYASAI-SECRET-KEY')
    // The real control for the narrow select is the SELECT-KEYS assertion in the test above.
  })

  test('null license columns pass through as null, not as empty strings', async () => {
    orgRow = { ...orgRow, licenseStatus: null, licenseExpiresAt: null, brandingJson: null }
    const body = (await (await GET()).json()) as { organization: Record<string, unknown> }
    expect(body.organization.licenseStatus).toBeNull()
    expect(body.organization.licenseExpiresAt).toBeNull()
  })

  test('a MISSING org is 404 with its own message and no typed envelope', async () => {
    // A brand-new session with a deleted org is a real state (the FK cascade has not run yet in a race). Pinned as
    // a string error: the org view reads `error` as a string here.
    orgRow = null
    const res = await GET()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Organization not found.' })
  })

  test('GET enters the org context before the read', async () => {
    await GET()
    expect(events[0]).toBe('enterWithOrg:org-1')
  })

  test('GET is NOT admin-only — a viewer may read their own org', async () => {
    user = { ...adminUser, role: 'viewer' }
    expect((await GET()).status).toBe(200)
    expect(events).not.toContain('requireRole:admin')
  })

  test('a read failure is 500 through the typed mapper and never leaks the driver message', async () => {
    findThrows = new Error('connect ECONNREFUSED 10.0.0.5:5432')
    const res = await GET()
    expect(res.status).toBe(500)
    const t = await res.text()
    expect(t).not.toContain('ECONNREFUSED')
    expect(t).not.toContain('10.0.0.5')
    expect(handleErrorArgs).toEqual([{ fallback: 'Failed to load organization.', status: 500 }])
  })
})

describe('PATCH — the admin gate', () => {
  test('an analyst is refused with a 403 before any read or write', async () => {
    // Control C3 (moving requireRole below the body parse, or deleting it): red. Branding is customer-visible on
    // every page, so an analyst renaming the org is a defacement vector.
    user = { ...adminUser, role: 'analyst' }
    const res = await patch({ name: 'Hijacked' })
    expect(res.status).toBe(403)
    expect(findQueries).toHaveLength(0)
    expect(updateQueries).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  test('a viewer is refused too', async () => {
    user = { ...adminUser, role: 'viewer' }
    expect((await patch({ name: 'X' })).status).toBe(403)
  })

  test('the refusal comes from requireRole with the literal admin role', async () => {
    user = { ...adminUser, role: 'viewer' }
    await patch({ name: 'X' })
    expect(events).toContain('requireRole:admin')
  })

  test('THE ROLE CHECK RUNS AFTER THE ORG CONTEXT IS ENTERED', async () => {
    // Ordering pin: requireRole before enterWithOrg would throw from outside the tenant context, and any
    // subsequent DB work in a real handler would run unscoped. enterWith, then the gate, then the write.
    await patch({ name: 'Ok' })
    expect(events.indexOf('enterWithOrg:org-1')).toBeLessThan(events.indexOf('requireRole:admin'))
  })

  test('governance is not bypassed by a body-supplied role', async () => {
    user = { ...adminUser, role: 'viewer' }
    const res = await patch({ name: 'X', role: 'admin' })
    expect(res.status).toBe(403)
  })
})

describe('PATCH — the write', () => {
  test('the update targets the SESSION org id and nothing else', async () => {
    // Control C4 (adding `body.id ??` to the where clause): red. That single change is a cross-tenant rename.
    await patch({ name: 'Renamed' })
    expect(updateQueries[0]!.where).toEqual({ id: 'org-1' })
  })

  test('a body-supplied id is IGNORED (no IDOR through the update payload)', async () => {
    // The strongest cross-tenant probe available against this route: a hostile body naming another org. The where
    // clause must not pick it up.
    await patch({ id: 'org-victim', organizationId: 'org-victim', name: 'Mine now' })
    expect(updateQueries[0]!.where).toEqual({ id: 'org-1' })
    expect(updateQueries[0]!.data).toEqual({ name: 'Mine now' })
  })

  test('only the fields actually supplied are written', async () => {
    // Prisma treats `undefined` as "leave alone"; an explicit '' or null would CLEAR the column. A rename must not
    // wipe the customer's branding.
    await patch({ name: 'Renamed' })
    expect(updateQueries[0]!.data).toEqual({ name: 'Renamed' })
  })

  test('name and brandingJson can be set together', async () => {
    await patch({ name: 'Acme ID', brandingJson: '{"logo":"x"}' })
    expect(updateQueries[0]!.data).toEqual({ name: 'Acme ID', brandingJson: '{"logo":"x"}' })
  })

  test('an EMPTY brandingJson string IS applied (it is how branding is cleared)', async () => {
    // The name guard is truthiness-based, the branding guard is typeof-based. Recorded as the current asymmetry.
    await patch({ brandingJson: '' })
    expect(updateQueries[0]!.data).toEqual({ brandingJson: '' })
  })

  test('a whitespace-only name is IGNORED rather than clearing the name', async () => {
    await patch({ name: '   ' })
    expect(updateQueries).toHaveLength(0)
  })

  test('names are TRIMMED before storage', async () => {
    await patch({ name: '  Padded  ' })
    expect(updateQueries[0]!.data).toEqual({ name: 'Padded' })
  })

  test('an EMPTY body is a 400 with NO update and NO audit', async () => {
    // Control C5 (deleting the empty-payload guard): red. Without it the route issues an update with `data: {}`
    // and writes an ORG_UPDATED audit row for a change that did not happen.
    const res = await patch({})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'No fields provided for update.' })
    expect(updateQueries).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  test('a WRONG-TYPED name is ignored rather than coerced', async () => {
    // `42` must not become "42"; Prisma would either reject it or store a value no UI intended.
    const res = await patch({ name: 42 })
    expect(res.status).toBe(400)
    expect(updateQueries).toHaveLength(0)
  })

  test('a WRONG-TYPED brandingJson is ignored rather than stringified', async () => {
    const res = await patch({ brandingJson: { logo: 'x' } })
    expect(res.status).toBe(400)
    expect(updateQueries).toHaveLength(0)
  })

  test('a malformed JSON body is a 400 rather than a crash', async () => {
    expect((await patch('not json')).status).toBe(400)
  })

  test('an unparseable body is treated as empty, not as a 500', async () => {
    // `req.json().catch(() => ({}))` is the reason this is a 400: the route chooses the empty-payload verdict.
    const res = await patch('<html>')
    expect(res.status).toBe(400)
    expect(handleErrorArgs).toHaveLength(0)
  })

  test('the update SELECT is the same seven columns as the read', async () => {
    await patch({ name: 'X' })
    const select = updateQueries[0]!.select as Record<string, unknown>
    expect(Object.keys(select).sort()).toEqual(ORG_SELECT_KEYS)
  })

  test('it answers { ok: true, organization } with the updated row', async () => {
    updateRow = { id: 'org-1', name: 'Renamed', slug: 'acme' }
    const body = (await (await patch({ name: 'Renamed' })).json()) as { ok: boolean; organization: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.organization.name).toBe('Renamed')
  })
})

describe('PATCH — the audit', () => {
  test('the audit records the acting user and the FIELD NAMES, never the values', async () => {
    // An org name can be customer PII, and a brandingJson blob can be large; the audit trail needs to show WHICH
    // fields moved, not what the customer renamed themselves to.
    await patch({ name: 'Secret Project Codename', brandingJson: '{"logo":"x"}' })
    expect(audits[0]).toMatchObject({ userId: 'u1', action: 'ORG_UPDATED' })
    expect(audits[0]!.detail).toEqual({ fields: ['name', 'brandingJson'] })
    expect(JSON.stringify(audits[0])).not.toContain('Secret Project Codename')
  })

  test('the audit lists the fields in DATA order, so it matches the write', async () => {
    await patch({ brandingJson: '{}', name: 'X' })
    expect((audits[0]!.detail as { fields: string[] }).fields).toEqual(['name', 'brandingJson'])
  })

  test('the audit happens AFTER the write', async () => {
    // Ordering pin: an audit row for a write that never landed fabricates a change history.
    await patch({ name: 'X' })
    expect(events.indexOf('organization.update')).toBeLessThan(events.indexOf('writeAudit'))
  })

  test('it uses the acting user, not a constant', async () => {
    user = { ...adminUser, userId: 'u-admin-2' }
    await patch({ name: 'X' })
    expect(audits[0]!.userId).toBe('u-admin-2')
  })

  test('a WRITE FAILURE is 500 with the route-specific fallback and NO audit', async () => {
    updateThrows = new Error('deadlock detected on relation organizations')
    const res = await patch({ name: 'X' })
    expect(res.status).toBe(500)
    expect(handleErrorArgs).toEqual([{ fallback: 'Failed to update organization.', status: 500 }])
    expect(audits).toHaveLength(0)
    expect(await res.text()).not.toContain('deadlock')
  })

  test('a FORBIDDEN error keeps its 403 status instead of collapsing to 500', async () => {
    // handleApiError branches on the error CLASS; this proves the seam is wired to the mapper rather than to a
    // local catch that would have flattened it.
    user = { ...adminUser, role: 'viewer' }
    const body = (await (await patch({ name: 'X' })).json()) as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })
})
