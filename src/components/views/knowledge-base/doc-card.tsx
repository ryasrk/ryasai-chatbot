'use client'

import { useEffect, useRef, useState } from 'react'
import { Eye, Trash2, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { extractError } from '@/lib/extract-error'
import type { DocumentItem } from '@/lib/types'
import { fileIconFor, STATUS_BADGE, categoryColor } from './helpers'

/**
 * Is the cognify step finished, either way?
 *
 * SINGLE SOURCE for the terminal-state rule, because three places need to agree and they used to be
 * three hand-written comparisons: this card's display, this card's poll loop, and the knowledge
 * view's "is anything still pending" check. They already drifted once — the view treats `null` as
 * settled (a row that never had a status is not something it knows how to wait for) while the card
 * must treat it as UNSETTLED (it shows the optimistic state and would otherwise stop polling before
 * the job that has not started yet could report anything).
 *
 * `completed` and `failed` are the only terminal states. `processing`, `null` and any unknown string
 * are not terminal.
 */
export function isCognifySettled(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'failed'
}

/**
 * How often the card re-reads its own document while a reprocess is in flight.
 *
 * A module constant so the two sites that arm the chain (the first tick and the loop's
 * continue-branch) cannot drift apart, and so the value is legible in one place.
 */
const POLL_INTERVAL_MS = 5_000

export function DocCard({
  doc,
  deleting,
  onDetail,
  onDelete,
  onToggle,
}: {
  doc: DocumentItem
  deleting?: boolean
  onDetail: () => void
  onDelete: () => void
  onToggle: (checked: boolean) => void
}) {
  const [toggling, setToggling] = useState(false)
  const [retrying, setRetrying] = useState(false)
  // Local status override after a reprocess — the card shows Processing
  // immediately, then polling refreshes it with the server's answer.
  const [override, setOverride] = useState<{ status?: string; cognifyStatus?: string | null }>({})
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * The `doc` VALUES that were on screen when the optimistic override was created.
   *
   * WHY: an optimistic value must never outlive the server's answer. The override used to win over the
   * prop UNCONDITIONALLY (`override.cognifyStatus !== undefined ? override... : doc.cognifyStatus`), so
   * the moment the parent list learned the truth, this card ignored it. If the card's own poll had
   * already died — ceiling reached, or its timer handle overwritten by a second Retry click — the badge
   * kept saying "processing" with nothing left to correct it, which is the exact reported symptom
   * ("kenapa processing sangat lamaaa") re-entering by another door.
   *
   * The fix keys on CHANGE: while the props still read what they read at click time (typically
   * `cognifyStatus: 'failed'`), the override is the fresher value and bridges the gap. As soon as the
   * props differ — the parent refetched and now says `completed` — the server has a newer answer and the
   * override is dropped.
   */
  const overrideBase = useRef<{ status: string; cognifyStatus: string | null } | null>(null)
  /**
   * Whether this card is still responsible for polling.
   *
   * Set false by the unmount cleanup. The poll chain is a `setTimeout` WHOSE FETCH IS AWAITED, so the
   * cleanup can run while `pollOnce` is suspended mid-request; without this flag the continuation
   * re-armed a fresh timer AFTER unmount — a chain nobody could ever clear, polling a deleted card for
   * up to ten minutes and calling `setState` on an unmounted component.
   */
  const alive = useRef(true)
  /**
   * Synchronous re-entrancy latch for `handleRetry`. Unlike `retrying` state, this is already true when
   * a second click in the same tick runs the handler. See the comment inside `handleRetry`.
   */
  const retryingRef = useRef(false)
  /** Synchronous latch for the enable/disable switch — see the handler's comment. */
  const togglingRef = useRef(false)
  /**
   * How long the card has been showing an optimistic "processing" state.
   *
   * WHY THIS EXISTS. The card used to schedule EXACTLY ONE refresh, 8 seconds after a reprocess. Real
   * cognify takes 45-148s (measured on this deployment), so the single refresh always landed while the
   * job was still running, and the card then displayed "processing" FOREVER — the DB said `completed`
   * and the screen said the opposite, with nothing to correct it. A user reported exactly that:
   * "kenapa processing sangat lamaaa" on a document that had finished.
   *
   * So the card now polls until the state is terminal, and this counter drives the honest progress text
   * while it waits.
   */
  const [elapsed, setElapsed] = useState(0)
  /**
   * Whether a poll chain is currently running for this card, and whether one ran out of budget.
   *
   * These exist so the badge can be HONEST about what the app is still doing. `pollActive` drives an
   * `aria-live` status; `pollExpired` switches the label from a progress claim to a plain statement
   * that the app has stopped waiting. Without the second one, a job that never settled left "Building
   * graph · 600s" on screen for as long as the user cared to stare at it — the monitor was gone and
   * the display still promised it was watching.
   */
  const [pollActive, setPollActive] = useState(false)
  const [pollExpired, setPollExpired] = useState(false)

  useEffect(() => {
    return () => {
      // Order matters: `alive = false` first, so an IN-FLIGHT `pollOnce` cannot re-arm the chain from
      // its `await` continuation after this cleanup has already cleared the handle it knew about.
      alive.current = false
      if (pollTimer.current) {
        clearTimeout(pollTimer.current)
        pollTimer.current = null
      }
    }
  }, [])

  /**
   * Drop the optimistic override once the properties it was a guess about actually change.
   *
   * See `overrideBase` above. Compared by VALUE and not by object identity, so an unrelated list
   * refetch that happens to carry the same statuses does not needlessly discard a still-valid override.
   */
  useEffect(() => {
    const base = overrideBase.current
    if (!base) return
    if (doc.status !== base.status || doc.cognifyStatus !== base.cognifyStatus) {
      overrideBase.current = null
      setOverride({})
    }
  }, [doc.status, doc.cognifyStatus])

  const isFailed = doc.status === 'error' || doc.cognifyStatus === 'failed'
  const effectiveDoc: DocumentItem = {
    ...doc,
    status: override.status ?? doc.status,
    cognifyStatus: override.cognifyStatus !== undefined ? override.cognifyStatus : doc.cognifyStatus,
  }

  /**
   * A terminal state is the only thing that stops the poll. `isCognifySettled` is the shared rule;
   * `processing`, null and any unknown string all mean "still to come" — null because a row created
   * before the step was queued has no value yet, and treating that as terminal is how the card would
   * stop polling before the job even started.
   */
  const cognifySettled = isCognifySettled(effectiveDoc.cognifyStatus)

  useEffect(() => {
    if (cognifySettled) {
      setElapsed(0)
      return
    }
    // Gated on the poll actually running. Once the ceiling is reached there is nothing left to time:
    // an interval that kept counting would tick once a second for as long as the user stayed on the
    // page, implying a watch that had already ended.
    if (!pollActive || pollExpired) return
    if (!override.cognifyStatus) return
    // ONE interval at a time. The tick is a functional update (`n => n + 1`) and an interval that
    // survived a re-run would double-count seconds, which the badge then reports as fact.
    const t = setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [cognifySettled, override.cognifyStatus, pollActive, pollExpired])

  async function handleRetry() {
    /*
     * A REF, not the `retrying` state, for the re-entrancy test.
     *
     * `if (retrying) return` reads the value captured when the handler was created, so two clicks
     * dispatched before React re-renders (a double-click, or a keyboard Enter plus a click) both see
     * `false` and both proceed — two POSTs, two queued embed+cognify job pairs for one document, two
     * poll chains. A ref is updated synchronously, so the second call is always refused.
     */
    if (retryingRef.current) return
    retryingRef.current = true
    setRetrying(true)
    try {
      const res = await fetch(`/api/documents/${doc.id}/reprocess`, { method: 'POST' })
      if (!res.ok) {
        // Surfaced, not swallowed into the console: a retry the user pressed and that the server
        // REFUSED looked identical to a retry that worked — the card flipped to "processing" either
        // way, because nothing here distinguished the two.
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error('Could not queue reprocessing', {
          description: extractError(body?.error, 'The server refused the reprocess request.'),
        })
        return
      }
      // Record what the card was SHOWING, so a later prop change can retire this override.
      overrideBase.current = { status: doc.status, cognifyStatus: doc.cognifyStatus ?? null }
      setOverride({ status: 'ready', cognifyStatus: 'processing' })
      setElapsed(0)
      setPollExpired(false)

      /*
       * POLL UNTIL TERMINAL, with a bound.
       *
       * The old code scheduled ONE refresh at 8s and stopped. Cognify measures 45-148s here, so the
       * single look always saw `processing` and the card kept that verdict indefinitely.
       *
       * The ceiling matters as much as the loop: an unbounded poll against a job that died without
       * writing a status would spin forever. After the ceiling the card stops claiming to know and SAYS
       * SO (`pollExpired` below), rather than leaving "Building graph" on screen as if it were news —
       * an unbounded wait presented as progress is the same complaint in a new costume.
       */
      const POLL_CEILING_MS = 10 * 60_000
      const startedAt = Date.now()
      // A poll chain owns the card's timer slot. Clear any chain still running from an EARLIER retry
      // before starting this one: two live chains both write `pollTimer.current`, so the first becomes
      // unreachable by the cleanup below — it would keep issuing requests for up to ten minutes, and
      // `clearTimeout` at unmount could only ever clear the second.
      if (pollTimer.current) clearTimeout(pollTimer.current)
      setPollActive(true)

      const pollOnce = async () => {
        try {
          const detail = await fetch(`/api/documents/${doc.id}`, { cache: 'no-store' })
          if (detail.ok) {
            const data = (await detail.json()) as {
              document?: { status?: string; cognifyStatus?: string | null }
            }
            if (data.document) {
              const next = {
                status: data.document.status,
                cognifyStatus: data.document.cognifyStatus ?? null,
              }
              // The unmount guard covers the AWAITED fetch: switching views mid-request would
              // otherwise apply this answer to a component that no longer exists.
              if (!alive.current) return
              setOverride(next)
              // Stop as soon as the server reports a terminal state — continuing would be busywork
              // against a settled row.
              if (isCognifySettled(next.cognifyStatus)) {
                setPollActive(false)
                return
              }
            }
          }
        } catch {
          // Transient: keep polling. The list refetch on remount is the final reconciliation.
        }
        if (!alive.current) return
        if (Date.now() - startedAt < POLL_CEILING_MS) {
          pollTimer.current = setTimeout(pollOnce, POLL_INTERVAL_MS)
        } else {
          // Out of budget. Stop, and say so, instead of letting the waiting badge imply that the app
          // is still watching something it has stopped watching.
          setPollActive(false)
          setPollExpired(true)
        }
      }
      /*
       * The FIRST tick. The loop then reschedules ITSELF while the state is unsettled, so there are
       * deliberately two `setTimeout(pollOnce, POLL_INTERVAL_MS)` sites: this entry point and the
       * continue-branch inside. There is exactly one CHAIN — adding a `void pollOnce()` here as well
       * would start a second, independent chain against the same document.
       */
      pollTimer.current = setTimeout(pollOnce, POLL_INTERVAL_MS)
    } finally {
      retryingRef.current = false
      setRetrying(false)
    }
  }

  const { Icon, className: iconCls } = fileIconFor(effectiveDoc.type)
  const status = STATUS_BADGE[effectiveDoc.status] ?? STATUS_BADGE.error
  const catBadge = categoryColor(effectiveDoc.category ?? 'Uncategorized')
  const isEnabled = effectiveDoc.isEnabled !== false

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              'h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
              iconCls,
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-xs leading-snug break-words line-clamp-1">
              {effectiveDoc.name}
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={cn('text-[10px]', catBadge)}>
                {effectiveDoc.category ?? 'Uncategorized'}
              </Badge>
              <Badge variant="outline" className={cn('text-[10px]', status.className)}>
                {status.label}
              </Badge>
              {effectiveDoc.cognifyStatus && (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px]',
                    effectiveDoc.cognifyStatus === 'completed' && 'bg-primary/15 text-primary border-primary/20',
                    effectiveDoc.cognifyStatus === 'processing' && 'bg-warning/15 text-warning border-warning/20',
                    effectiveDoc.cognifyStatus === 'failed' && 'bg-destructive/15 text-destructive border-destructive/20',
                  )}
                >
                  {/*
                    Say WHAT is happening and HOW LONG it takes, once it has run long enough to be
                    worth explaining. The bare word "processing" is what produced the user report
                    "kenapa processing sangat lamaaa" — it gave no scale, so 90 seconds of normal work
                    looked like a hang.

                    The elapsed counter appears after 20s, which is past the short end of the measured
                    45-148s range for this step and therefore the point where a wait starts to feel
                    unexplained rather than merely slow.

                    Once the poll gives up, the elapsed count is REPLACED rather than kept: "Building
                    graph · 600s" reads as a live measurement, and after the ceiling there is no
                    measurement left, only a state the app has stopped tracking.
                  */}
                  {effectiveDoc.cognifyStatus === 'completed'
                    ? 'Graph'
                    : effectiveDoc.cognifyStatus === 'processing'
                      ? pollExpired
                        ? 'Graph status unknown'
                        : elapsed >= 20
                          ? `Building graph · ${elapsed}s`
                          : 'Building graph'
                      : effectiveDoc.cognifyStatus}
                </Badge>
              )}
            </div>
            {/*
              The badge above changes on its own while a user waits — and every one of those changes was
              invisible to a screen reader, because a `<span>` is not a live region. `aria-live="polite"`
              with `aria-atomic="true"` announces the WHOLE sentence each time (not a diff of it), and
              `role="status"` gives it the standard live-region semantics without stealing focus.

              Deliberately polite, not assertive: this is a progress update, and interrupting whatever
              the user is currently reading to say "125s" would be worse than the silence it replaces.
              The element is always mounted so the region exists BEFORE its content changes; a live
              region added at the same moment as its text is frequently not announced at all. Rendered
              empty (not `display:none`) when idle, which is what keeps it a valid target.
            */}
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {effectiveDoc.cognifyStatus === 'processing'
                ? pollExpired
                  ? 'Building the knowledge graph. The app has stopped checking for progress after 10 minutes.'
                  : elapsed >= 20
                    ? `Building the knowledge graph, ${elapsed} seconds so far.`
                    : 'Building the knowledge graph.'
                : effectiveDoc.cognifyStatus === 'completed'
                  ? 'Knowledge graph built.'
                  : effectiveDoc.cognifyStatus === 'failed'
                    ? 'Knowledge graph build failed.'
                    : ''}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-medium text-muted-foreground">
              {isEnabled ? 'ON' : 'OFF'}
            </span>
            <Switch
              checked={isEnabled}
              disabled={toggling}
              onCheckedChange={async (checked) => {
                // Same synchronous latch as the reprocess button: a Switch fires once per interaction,
                // but the toggle round-trips to the server, and a second one while the first is open
                // would race two PATCHes whose optimistic reverts can then disagree with each other.
                if (togglingRef.current) return
                togglingRef.current = true
                setToggling(true)
                try {
                  await onToggle(checked)
                } finally {
                  togglingRef.current = false
                  setToggling(false)
                }
              }}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-2 pt-0">
        {isFailed && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRetry}
            disabled={retrying}
            className="w-full text-xs h-7 col-span-2"
            icon={retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          >
            {retrying ? 'Queuing' : 'Retry Processing'}
          </Button>
        )}
        <div className="mt-auto grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onDetail}
            className="text-xs h-7"
            icon={<Eye className="h-3 w-3" />}
          >
            Details
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
            icon={deleting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
          >
            {deleting ? 'Deleting' : 'Delete'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
