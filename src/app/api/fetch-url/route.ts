import { NextRequest, NextResponse } from 'next/server'
import { fetchUrlForPlanner } from '@/lib/web-fetch'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * POST /api/fetch-url — read a public web page as text.
 *
 * Delegates to fetchUrlForPlanner, the same helper backing the planner's
 * web_fetch tool. This route used to reimplement it with jsdom + Readability and
 * drifted in two ways: it checked isBlockedHost but NOT isBlockedHostAsync, so
 * it alone was open to DNS rebinding; and importing jsdom broke the production
 * build (jsdom -> css-tree require()s ../data/patch.json by relative path, which
 * the bundler cannot resolve).
 *
 * ponytail: tag-stripping instead of Readability article extraction. Readability
 * is the better extractor, but it needs a DOM and jsdom is unbundlable here.
 * Upgrade path: a bundler-safe DOM (linkedom) if extraction quality starts to
 * matter — measure against the planner's web_fetch first, since both would want it.
 */
export async function POST(req: NextRequest) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { url } = (await req.json().catch(() => ({}))) as { url?: string }
    if (!url) return NextResponse.json({ error: 'url is required.' }, { status: 400 })

    // Shape-check here so a malformed URL is a client error. fetchUrlForPlanner
    // revalidates (and adds the protocol + SSRF checks); this only decides whether
    // the caller or the upstream is at fault, which the status code has to reflect.
    try {
      new URL(url)
    } catch {
      return NextResponse.json({ error: 'URL is invalid.' }, { status: 400 })
    }

    const result = await fetchUrlForPlanner(url)
    if (!result.ok) {
      // Blocked host is a policy refusal (403); anything else is an upstream failure.
      const blocked = result.error?.includes('blocked')
      return NextResponse.json({ error: result.error ?? 'Fetch failed.' }, { status: blocked ? 403 : 502 })
    }
    if (!result.content) {
      return NextResponse.json({ error: 'Could not extract content.' }, { status: 422 })
    }

    return NextResponse.json({
      ok: true,
      title: result.title ?? '',
      url,
      content: result.content,
      length: result.content.length,
    })
  } catch (e) {
    return handleApiError(e, 'Failed to fetch URL.')
  }
}
