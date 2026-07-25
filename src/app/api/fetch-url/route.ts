import { NextRequest, NextResponse } from 'next/server'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import { isBlockedHost } from '@/lib/llm-config'
import { getActiveUser, handleApiError } from '@/lib/session'

export async function POST(req: NextRequest) {
  try {
    await getActiveUser()
    const { url } = (await req.json().catch(() => ({}))) as { url?: string }
    if (!url) return NextResponse.json({ error: 'url wajib diisi.' }, { status: 400 })

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return NextResponse.json({ error: 'URL tidak valid.' }, { status: 400 })
    }

    if (isBlockedHost(parsed.hostname)) {
      return NextResponse.json({ error: 'Host diblokir.' }, { status: 403 })
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ryasai/1.0)' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    })

    if (!res.ok) {
      return NextResponse.json({ error: `Fetch gagal: HTTP ${res.status}` }, { status: 502 })
    }

    const html = await res.text()
    const doc = new JSDOM(html, { url })
    const reader = new Readability(doc.window.document)
    const article = reader.parse()

    if (!article || !article.textContent) {
      return NextResponse.json({ error: 'Tidak bisa ekstrak konten.' }, { status: 422 })
    }

    const content = article.textContent.trim().slice(0, 10000)

    return NextResponse.json({
      ok: true,
      title: article.title ?? '',
      url,
      content,
      length: content.length,
    })
  } catch (e) {
    return handleApiError(e, 'Gagal fetch URL.')
  }
}
