'use client'

import { useEffect, useState } from 'react'
import { Loader2, Building2, RefreshCw, BadgeCheck, CreditCard } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FormSkeleton, ErrorState } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { extractError } from '@/lib/extract-error'
import type { ActiveUser } from '@/lib/types'
import { BuyLicenseDialog } from '@/components/views/billing/buy-license-dialog'
import { daysUntilExpiry, expiryCountdownLabel } from '@/lib/billing-ui'

export interface OrgInfo {
  id: string
  name: string
  slug: string
  brandingJson: string | null
  licensePlan: string | null
  licenseStatus: string
  licenseExpiresAt: string | null
}

export interface LicenseInfo {
  key: string | null
  plan: string | null
  status: string
  validatedAt: string | null
  expiresAt: string | null
}

export function planBadge(plan: string | null) {
  if (plan === 'enterprise') return <Badge variant="warning" className="text-[10px]">Enterprise</Badge>
  if (plan === 'pro') return <Badge variant="info" className="text-[10px]">Pro</Badge>
  if (plan === 'starter') return <Badge variant="secondary" className="text-[10px]">Starter</Badge>
  return <Badge variant="outline" className="text-[10px]">None</Badge>
}

export function statusBadge(status: string) {
  if (status === 'valid') return <Badge variant="success" className="text-[10px]">Valid</Badge>
  if (status === 'expired') return <Badge variant="destructive" className="text-[10px]">Expired</Badge>
  if (status === 'invalid') return <Badge variant="destructive" className="text-[10px]">Invalid</Badge>
  if (status === 'suspended') return <Badge variant="destructive" className="text-[10px]">Suspended</Badge>
  return <Badge variant="secondary" className="text-[10px]">None</Badge>
}

export function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function OrgTab() {
  const [me, setMe] = useState<ActiveUser | null>(null)
  const [org, setOrg] = useState<OrgInfo | null>(null)
  const [license, setLicense] = useState<LicenseInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [error, setError] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [revalidating, setRevalidating] = useState(false)
  const [buyOpen, setBuyOpen] = useState(false)

  const isAdmin = me?.role === 'admin'

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [meRes, orgRes, licRes] = await Promise.all([
        fetch('/api/me', { cache: 'no-store' }),
        fetch('/api/org', { cache: 'no-store' }),
        fetch('/api/org/license', { cache: 'no-store' }),
      ])
      if (!meRes.ok || !orgRes.ok) throw new Error('Failed to load organization.')
      const [meData, orgData, licData] = await Promise.all([
        meRes.json(),
        orgRes.json(),
        licRes.ok ? licRes.json() : Promise.resolve({ license: null }),
      ])
      setMe(meData as ActiveUser)
      setOrg(orgData.organization as OrgInfo)
      setEditName(orgData.organization?.name ?? '')
      setLicense((licData as { license: LicenseInfo | null }).license ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleSaveName() {
    if (!editName.trim()) return
    setSavingName(true)
    try {
      const res = await fetch('/api/org', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(extractError(data, 'Failed to update organization.')); return }
      setOrg(data.organization as OrgInfo)
      toast.success('Organization name updated.')
    } catch {
      toast.error('Unable to connect to the server.')
    } finally {
      setSavingName(false)
    }
  }

  async function handleRevalidate() {
    setRevalidating(true)
    try {
      const res = await fetch('/api/org/license', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(extractError(data, 'License re-validation failed.')); return }
      toast.success(`License ${data.license?.status ?? 'validated'}.`)
      const [orgRes, licRes] = await Promise.all([
        fetch('/api/org', { cache: 'no-store' }),
        fetch('/api/org/license', { cache: 'no-store' }),
      ])
      if (orgRes.ok) { const d = await orgRes.json(); setOrg(d.organization as OrgInfo) }
      if (licRes.ok) { const d = await licRes.json(); setLicense(d.license as LicenseInfo) }
    } catch {
      toast.error('Unable to connect to the server.')
    } finally {
      setRevalidating(false)
    }
  }

  if (loading) return showSkeleton ? <FormSkeleton fields={3} /> : null
  if (error || !org) return <ErrorState message={error ?? 'Organization data unavailable.'} onRetry={load} />

  const plan = license?.plan ?? org.licensePlan
  const status = license?.status ?? org.licenseStatus
  const expiresAt = license?.expiresAt ?? org.licenseExpiresAt

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs flex items-center gap-2">
            <Building2 className="h-3.5 w-3.5" />
            Organization
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            {isAdmin ? (
              <div className="flex gap-2">
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} disabled={savingName}
                  className="flex-1" />
                <Button
                  size="sm"
                  icon={savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
                  onClick={() => void handleSaveName()}
                  disabled={savingName || editName.trim() === org.name}
                >
                  Save
                </Button>
              </div>
            ) : (
              <div className="text-sm font-medium">{org.name}</div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Slug</Label>
            <code className="rounded bg-muted px-2 py-1 text-xs font-mono">{org.slug}</code>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs flex items-center gap-2">
            <BadgeCheck className="h-3.5 w-3.5" />
            License
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] text-muted-foreground mb-1">Plan</div>
              {planBadge(plan)}
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-1">Status</div>
              {statusBadge(status)}
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-1">Expires</div>
              <div className="text-xs font-medium">
                {expiresAt ? (
                  <>
                    {fmtDate(expiresAt)}
                    <span className={cn('ml-1.5', daysUntilExpiry(expiresAt, new Date()) <= 3 ? 'text-destructive' : 'text-muted-foreground')}>
                      ({expiryCountdownLabel(expiresAt, new Date())})
                    </span>
                  </>
                ) : (
                  'Lifetime'
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-1">Last Validated</div>
              <div className="text-xs font-medium">{fmtDate(license?.validatedAt ?? null)}</div>
            </div>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                icon={revalidating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                onClick={() => void handleRevalidate()}
                disabled={revalidating}
              >
                Revalidate
              </Button>
              <Button
                size="sm"
                icon={<CreditCard className="h-3.5 w-3.5" />}
                onClick={() => setBuyOpen(true)}
              >
                {status === 'unpaid' || !plan ? 'Buy License' : 'Extend Subscription'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Subscription checkout — QRIS via Midtrans Snap. Settlement refreshes
          license data (onSettled) and the local card state (load). */}
      <BuyLicenseDialog
        open={buyOpen}
        onOpenChange={setBuyOpen}
        onSettled={() => {
          setBuyOpen(false)
          void load()
        }}
      />
    </div>
  )
}
