import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { id } = await ctx.params

    const runs = await db.scheduledRunLog.findMany({ // nosemgrep
      where: { scheduledRunId: id },
      orderBy: { executedAt: 'desc' },
      take: 50,
    })

    // Counted while mapping, below, so the response can say WHICH rows came back damaged.
    const brokenToolRuns: string[] = []

    return NextResponse.json({
      ok: true,
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        answer: r.answer,
        error: r.error,
        // GUARDED. This ran inside a `.map()` over the whole history, so ONE corrupt row -- reachable if the
        // scheduler is killed mid-write -- threw out of the map and turned the ENTIRE history into a 500: the user
        // saw no runs at all because of one bad row. A row that cannot be parsed now reports `toolRuns: null` and
        // is FLAGGED, so the rest of the history renders and the corruption is visible instead of fatal.
        toolRuns: parseToolRuns(r.toolRunsJson, brokenToolRuns),
        latencyMs: r.latencyMs,
        executedAt: r.executedAt.toISOString(),
      })),
      // OMITTED when nothing is damaged, so an intact history keeps its exact previous shape and no client has to
      // learn a field it will never see. Present means "this response is PARTIAL in a way you should surface".
      ...(brokenToolRuns.length > 0 ? { damagedRows: brokenToolRuns.length } : {}),
    })
  } catch (err) {
    return handleApiError(err, 'Failed to load execution history.')
  }
}

/**
 * Parse a stored toolRuns blob without letting a damaged row take down the response.
 *
 * Returns `null` for absent, empty OR unparseable input, and pushes the row id onto `broken` so the caller can
 * tell "this run had no tool runs" apart from "this run record is damaged" -- the two used to look identical once
 * the throw was caught. The malformed TEXT is deliberately not echoed: it is tenant data and belongs in the log.
 */
function parseToolRuns(json: string | null, broken: string[]): unknown {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    broken.push('toolRuns')
    return null
  }
}
