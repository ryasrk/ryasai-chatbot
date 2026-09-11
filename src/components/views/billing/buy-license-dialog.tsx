'use client'

/**
 * BuyLicenseDialog — self-serve subscription purchase via Midtrans Snap (QRIS).
 * ===========================================================================
 * Flow: pick a pack → POST /api/billing/orders → Snap popup → poll
 * GET /api/billing/orders/[id] every 3s while pending → settlement shows a
 * reload prompt. If the Snap popup can't be loaded, falls back to the full-page
 * redirectUrl returned by the API.
 *
 * ponytail: Snap config reaches the browser via NEXT_PUBLIC_ vars
 * (NEXT_PUBLIC_MIDTRANS_CLIENT_KEY / NEXT_PUBLIC_MIDTRANS_IS_PRODUCTION) rather
 * than an extra config endpoint — they are public values by design and this
 * keeps the billing route surface owned by a single work stream.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, CreditCard, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatIdr, pollOutcome, snapScriptUrl, POLL_INTERVAL_MS } from '@/lib/billing-ui'

interface BillingPack {
  months: number
  amountIdr: number
}

interface CreateOrderResponse {
  orderId: string
  token: string
  redirectUrl: string
}

// ponytail: matches GET /api/billing/orders/[id] — payload is nested under
// `order`. Reading it flat once made the poller see `undefined` forever and
// the dialog hung on "Waiting for payment…" even after settlement.
interface OrderStatusResponse {
  order?: {
    status: string
    months: number
    amountIdr: number
  }
  /** Legacy flat shape tolerated defensively. */
  status?: string
}

declare global {
  interface Window {
    snap?: { pay: (token: string, options?: Record<string, unknown>) => void }
  }
}

type Phase = 'packs' | 'creating' | 'awaiting' | 'settled' | 'failed'

const FAILED_STATUS_MESSAGE: Record<string, string> = {
  expire: 'The payment window expired before payment was completed.',
  deny: 'The payment was denied by the payment provider.',
  cancel: 'The payment was cancelled.',
  failure: 'The payment failed. No charge was made.',
}

let snapLoadPromise: Promise<boolean> | null = null

function loadSnap(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false)
  if (window.snap) return Promise.resolve(true)
  if (snapLoadPromise) return snapLoadPromise
  snapLoadPromise = new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = snapScriptUrl(process.env.NEXT_PUBLIC_MIDTRANS_IS_PRODUCTION === 'true')
    script.setAttribute('data-client-key', process.env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY ?? '')
    script.onload = () => resolve(true)
    script.onerror = () => resolve(false)
    document.body.appendChild(script)
  })
  return snapLoadPromise
}

async function fetchJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}

function extractApiMessage(data: unknown, fallback: string): string {
  const err = (data as { error?: { message?: string } | string } | null)?.error
  if (typeof err === 'string') return err
  return err?.message ?? fallback
}

export function BuyLicenseDialog({
  open,
  onOpenChange,
  onSettled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once when the order settles — refresh identity/license state. */
  onSettled?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('packs')
  const [packs, setPacks] = useState<BillingPack[] | null>(null)
  const [packsError, setPacksError] = useState<string | null>(null)
  const [creatingMonths, setCreatingMonths] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failedStatus, setFailedStatus] = useState<string | null>(null)
  const [pendingAmount, setPendingAmount] = useState<number | null>(null)
  // Refs, not state: the poller must always read the latest order without
  // re-subscribing the interval effect on every buy.
  const orderIdRef = useRef<string | null>(null)
  const settledNotifiedRef = useRef(false)

  const loadPacks = useCallback(async () => {
    setPacks(null)
    setPacksError(null)
    try {
      const res = await fetch('/api/billing/pricing', { cache: 'no-store' })
      const data = await fetchJson<{ packs?: BillingPack[] }>(res)
      if (!res.ok || !Array.isArray(data?.packs)) {
        setPacksError(extractApiMessage(data, 'Failed to load pricing.'))
        return
      }
      setPacks(data.packs)
    } catch {
      setPacksError('Unable to connect to the server.')
    }
  }, [])

  useEffect(() => {
    if (open && phase === 'packs') void loadPacks()
  }, [open, phase, loadPacks])

  // Reset transient flow state whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      setPhase('packs')
      setError(null)
      setFailedStatus(null)
      setPendingAmount(null)
      setCreatingMonths(null)
      orderIdRef.current = null
      settledNotifiedRef.current = false
    }
  }, [open])

  const buy = async (months: number) => {
    setError(null)
    setCreatingMonths(months)
    try {
      const res = await fetch('/api/billing/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ months }),
      })
      const data = await fetchJson<CreateOrderResponse>(res)
      if (!res.ok || !data?.orderId || !data?.token || !data?.redirectUrl) {
        setError(extractApiMessage(data, 'Could not start the checkout. Please try again.'))
        return
      }
      orderIdRef.current = data.orderId
      const pack = packs?.find((p) => p.months === months)
      setPendingAmount(pack?.amountIdr ?? null)
      const loaded = await loadSnap()
      if (loaded && window.snap) {
        window.snap.pay(data.token)
      } else {
        // Popup unavailable — full-page checkout is the documented fallback.
        window.location.href = data.redirectUrl
        return
      }
      setPhase('awaiting')
    } catch {
      setError('Unable to connect to the server.')
    } finally {
      setCreatingMonths(null)
    }
  }

  // Poll the order while pending; stop on any terminal status.
  useEffect(() => {
    if (phase !== 'awaiting') return
    let cancelled = false
    let settledHere = false
    const tick = async () => {
      const id = orderIdRef.current
      if (!id || cancelled) return
      try {
        const res = await fetch(`/api/billing/orders/${id}`, { cache: 'no-store' })
        const data = await fetchJson<OrderStatusResponse>(res)
        const status = data?.order?.status ?? data?.status
        if (!status) return // transient bad response — keep polling
        const outcome = pollOutcome(status)
        if (!outcome.stop || cancelled) return
        if (outcome.result === 'settled') {
          settledHere = true
          setPhase('settled')
          if (!settledNotifiedRef.current) {
            settledNotifiedRef.current = true
            onSettled?.()
          }
        } else {
          setFailedStatus(status)
          setPhase('failed')
        }
      } catch {
        // network hiccup — keep polling until terminal or dialog closed
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
      if (settledHere) void loadPacks()
    }
  }, [phase, onSettled, loadPacks])

  const backToPacks = () => {
    setPhase('packs')
    setFailedStatus(null)
    setPendingAmount(null)
    orderIdRef.current = null
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="buy-license-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" />
            Buy Subscription
          </DialogTitle>
          <DialogDescription className="text-xs">
            Pay with QRIS via Midtrans. Your license activates automatically after payment.
          </DialogDescription>
        </DialogHeader>

        {phase === 'packs' && (
          <div className="space-y-2">
            {!packs && !packsError && (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
            {packsError && (
              <div className="space-y-2">
                <p className="text-xs text-destructive">{packsError}</p>
                <Button size="sm" variant="outline" onClick={() => void loadPacks()}>Retry</Button>
              </div>
            )}
            {packs?.map((p) => (
              <div key={p.months} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium">
                    {p.months} {p.months === 1 ? 'month' : 'months'}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{formatIdr(p.amountIdr)}</div>
                </div>
                <Button
                  size="sm"
                  disabled={creatingMonths !== null}
                  data-testid={`buy-pack-${p.months}`}
                  onClick={() => void buy(p.months)}
                >
                  {creatingMonths === p.months && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Buy
                </Button>
              </div>
            ))}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        {phase === 'awaiting' && (
          <div className="space-y-3 py-1 text-center" data-testid="payment-awaiting">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Waiting for payment…</p>
              {pendingAmount !== null && (
                <p className="text-xs text-muted-foreground">{formatIdr(pendingAmount)}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Complete the QRIS payment in the opened window. This updates automatically.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={backToPacks}>Back</Button>
          </div>
        )}

        {phase === 'settled' && (
          <div className="space-y-3 py-1 text-center" data-testid="payment-settled">
            <CheckCircle2 className="mx-auto h-8 w-8 text-green-600" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Payment received</p>
              <p className="text-xs text-muted-foreground">
                Your subscription is active. Reload the app to continue.
              </p>
            </div>
            <Button size="sm" className="w-full" onClick={() => window.location.reload()}>
              Reload App
            </Button>
          </div>
        )}

        {phase === 'failed' && (
          <div className="space-y-3 py-1">
            <p className="text-xs text-destructive">
              {FAILED_STATUS_MESSAGE[failedStatus ?? ''] ?? 'The payment did not complete.'}
            </p>
            <Button size="sm" variant="outline" className="w-full" onClick={backToPacks}>
              Back to Plans
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
