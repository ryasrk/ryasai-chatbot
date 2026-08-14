'use client'

import { useEffect, useState } from 'react'
import {
  User as UserIcon,
  ShieldCheck,
  Server,
  KeyRound,
  Lock,
  ScrollText,
  GitBranch,
  Terminal,
  Palette,
  Sun,
  Moon,
  Check,
  Loader2,
  Webhook,
  Users,
  Building2,
  Crown,
  Mail,
  Copy,
  Trash2,
  RefreshCw,
  BadgeCheck,
  Bell,
  Send,
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Delayed, FormSkeleton, TableSkeleton, ErrorState } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { extractError } from '@/lib/extract-error'
import type { ActiveUser } from '@/lib/types'
import { THEMES, type ThemeId, setTheme } from '@/lib/themes'

const initials = (name: string) =>
  name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()

export function SettingsView() {
  const [tab, setTab] = useState('profile')

  // Topbar account menu ("Profile") dispatches settings-tab after navigating here.
  useEffect(() => {
    const onTab = (e: Event) => {
      const t = (e as CustomEvent<{ tab: string }>).detail?.tab
      if (t) setTab(t)
    }
    window.addEventListener('settings-tab', onTab as EventListener)
    return () => window.removeEventListener('settings-tab', onTab as EventListener)
  }, [])

  return (
    <Tabs value={tab} onValueChange={setTab} className="w-full">
      <div className="min-w-0 overflow-x-auto -mx-1 px-1 pb-1">
      <TabsList className="w-max">
        <TabsTrigger value="profile" className="gap-1.5 text-xs">
          <UserIcon className="h-3.5 w-3.5" />
          Profile
        </TabsTrigger>
        <TabsTrigger value="theme" className="gap-1.5 text-xs">
          <Palette className="h-3.5 w-3.5" />
          Theme
        </TabsTrigger>
        <TabsTrigger value="security" className="gap-1.5 text-xs">
          <ShieldCheck className="h-3.5 w-3.5" />
          Security
        </TabsTrigger>
        <TabsTrigger value="system" className="gap-1.5 text-xs">
          <Server className="h-3.5 w-3.5" />
          System
        </TabsTrigger>
        <TabsTrigger value="team" className="gap-1.5 text-xs">
          <Users className="h-3.5 w-3.5" />
          Team
        </TabsTrigger>
        <TabsTrigger value="org" className="gap-1.5 text-xs">
          <Building2 className="h-3.5 w-3.5" />
          Organization
        </TabsTrigger>
        <TabsTrigger value="notifications" className="gap-1.5 text-xs">
          <Bell className="h-3.5 w-3.5" />
          Notifications
        </TabsTrigger>
      </TabsList>
      </div>

      <TabsContent value="profile" className="mt-3">
        <ProfileTab />
      </TabsContent>
      <TabsContent value="theme" className="mt-3">
        <ThemeTab />
      </TabsContent>
      <TabsContent value="security" className="mt-3">
        <SecurityTab />
      </TabsContent>
      <TabsContent value="system" className="mt-3">
        <SystemTab />
      </TabsContent>
      <TabsContent value="team" className="mt-3">
        <TeamTab />
      </TabsContent>
      <TabsContent value="org" className="mt-3">
        <OrgTab />
      </TabsContent>
      <TabsContent value="notifications" className="mt-3">
        <NotificationsTab />
      </TabsContent>
    </Tabs>
  )
}

/* ------------------------------- Profile Tab ------------------------------- */

function ProfileTab() {
  const [user, setUser] = useState<ActiveUser | null>(null)
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/me', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load profile.')
        return r.json()
      })
      .then((d: ActiveUser) => !cancelled && setUser(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Error.'))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return showSkeleton ? <FormSkeleton fields={3} /> : null
  }

  if (error || !user) {
    return <ErrorState message={error ?? 'User data unavailable.'} />
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {/* User info — compact */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10">
              <AvatarFallback
                className="text-sm font-semibold text-white"
                style={{ backgroundColor: 'oklch(0.55 0.18 250)' }}
              >
                {initials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{user.name}</div>
              <div className="text-xs text-muted-foreground truncate">{user.email}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Change password — compact, inline */}
      <ChangePasswordCard />
    </div>
  )
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (next !== confirm) { setError('Confirmation does not match.'); return }
    if (next.length < 8) { setError('New password must be at least 8 characters.'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data?.error || 'Failed to change password.'); return }
      toast.success('Password changed successfully.')
      setCurrent(''); setNext(''); setConfirm('')
    } catch {
      setError('Unable to connect to the server.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs flex items-center gap-2">
          <Lock className="h-3.5 w-3.5" />
          Change Password
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-2.5">
          <Input type="password" placeholder="Current password" required value={current}
            onChange={(e) => setCurrent(e.target.value)} disabled={saving} />
          <Input type="password" placeholder="New password (min. 8)" required minLength={8}
            value={next} onChange={(e) => setNext(e.target.value)} disabled={saving} />
          <Input type="password" placeholder="Confirm new password" required minLength={8}
            value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={saving} />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" size="sm" disabled={saving || !current || !next || !confirm}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Change Password
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/* ------------------------------- Security Tab ------------------------------- */

const SECURITY_ITEMS = [
  {
    icon: KeyRound,
    title: 'AES-256-GCM',
    short: 'Credential encryption',
    description:
      'Integration config (host, password, API key) is stored as an encrypted hex blob in the DB using AES-256-GCM.',
    detail: `const key = Buffer.from(MASTER_KEY_HEX, 'hex')
const nonce = crypto.randomBytes(12)
const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
// Stored: hex(nonce) + hex(tag) + hex(enc)`,
  },
  {
    icon: ShieldCheck,
    title: 'SQL AST Guardrails',
    short: 'SQL validation before execution',
    description:
      'Every SQL from the LLM is verified via AST. Rejects DML/DDL, multiple statements. Forces LIMIT 100.',
    detail: `const FORBIDDEN = ['DELETE','UPDATE','DROP','ALTER','TRUNCATE','INSERT','CREATE']
// 1. Parse AST  2. Reject FORBIDDEN  3. LIMIT 100  4. SELECT only`,
  },
  {
    icon: ScrollText,
    title: 'Audit Logging',
    short: 'Every action is logged',
    description:
      'Important actions are logged with info/warning/critical severity: SQL, guardrails, docs, RAG, etc.',
    detail: `await writeAudit({
  action: 'SQL_EXECUTE',
  severity: 'info',
  detail: { sql, rowCount, executionMs },
})`,
  },
] as const

function SecurityTab() {
  const [selected, setSelected] = useState<(typeof SECURITY_ITEMS)[number] | null>(null)

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {SECURITY_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.title}
              onClick={() => setSelected(item)}
              className="flex flex-col items-start gap-1.5 rounded-lg border p-2.5 text-left hover:bg-muted/40 transition-colors"
            >
              <Icon className="h-4 w-4 text-muted-foreground" />
              <div className="text-sm font-medium leading-tight">{item.title}</div>
              <div className="text-[11px] text-muted-foreground leading-tight">{item.short}</div>
            </button>
          )
        })}
      </div>

      <Dialog open={!!selected} onOpenChange={(v) => !v && setSelected(null)}>
        <DialogContent className="max-w-md p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              {selected && <selected.icon className="h-4 w-4 text-muted-foreground" />}
              {selected?.title}
            </DialogTitle>
            <DialogDescription className="text-xs">{selected?.short}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-[50vh] overflow-y-auto">
            <p className="text-xs text-muted-foreground leading-relaxed">{selected?.description}</p>
            {selected?.detail && (
              <pre className="bg-muted/60 rounded-md p-2.5 text-[10px] font-mono overflow-x-auto">
                <code>{selected.detail}</code>
              </pre>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/* ------------------------------- Theme Tab ------------------------------- */

function ThemeTab() {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    if (typeof window === 'undefined') return 'enterprise'
    return (localStorage.getItem('ryasai-theme') as ThemeId) || 'enterprise'
  })
  const [dark, setDarkState] = useState(() => {
    if (typeof window === 'undefined') return true
    const d = localStorage.getItem('ryasai-dark-mode')
    if (d !== null) return d === 'true'
    return true
  })

  function handleTheme(next: ThemeId) {
    setThemeState(next)
    setTheme(next, dark)
    toast.success(`Theme: ${THEMES.find((t) => t.id === next)?.name}`)
  }

  function handleDark(next: boolean) {
    setDarkState(next)
    setTheme(theme, next)
  }

  return (
    <div className="space-y-3">
      {/* Light/Dark toggle */}
      <Card>
        <CardContent className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {dark ? <Moon className="h-4 w-4 text-muted-foreground" /> : <Sun className="h-4 w-4 text-muted-foreground" />}
            <div>
              <div className="text-sm font-medium">Display Mode</div>
              <div className="text-[11px] text-muted-foreground">{dark ? 'Dark' : 'Light'}</div>
            </div>
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={!dark ? 'default' : 'outline'}
              icon={<Sun className="h-3.5 w-3.5" />}
              onClick={() => handleDark(false)}
              className="h-8"
            >
              Light
            </Button>
            <Button
              size="sm"
              variant={dark ? 'default' : 'outline'}
              icon={<Moon className="h-3.5 w-3.5" />}
              onClick={() => handleDark(true)}
              className="h-8"
            >
              Dark
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Theme picker */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {THEMES.map((t) => {
          const active = theme === t.id
          return (
            <button
              key={t.id}
              onClick={() => handleTheme(t.id)}
              className={cn(
                'flex flex-col items-start gap-2 rounded-md border p-3 text-left transition-all',
                active ? 'border-primary ring-1 ring-primary/30' : 'border-border hover:border-primary/40',
              )}
            >
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-1.5">
                  {t.swatch.map((c) => (
                    <div
                      key={c}
                      className="h-5 w-5 rounded-full border border-border/50"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                {active && <Check className="h-4 w-4 text-primary" />}
              </div>
              <div>
                <div className="text-sm font-medium">{t.name}</div>
                <div className="text-[11px] text-muted-foreground leading-tight">{t.description}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------- System Tab ------------------------------- */

function SystemTab() {
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="pt-4">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">Version</div>
              <div className="flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-semibold">v0.2.0</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">Mode</div>
              <Badge className="text-[10px]">Dedicated</Badge>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-0.5">Specification</div>
              <span className="text-sm font-medium">Knowledge & Query Engine</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-dashed">
        <CardContent className="pt-4 space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Terminal className="h-3.5 w-3.5" />
            <span>Reset development data:</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">./reset.sh</code>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2 border-t">
            <Webhook className="h-3.5 w-3.5" />
            <span>Incoming webhook:</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              POST /api/webhooks/incoming
            </code>
          </div>
          <p className="text-[11px] text-muted-foreground pl-5">
            Requires <code className="font-mono">INCOMING_WEBHOOK_SECRET</code> + <code className="font-mono">x-webhook-signature</code> header.
            Body: <code className="font-mono">{'{ "query": "..." }'}</code>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

/* --------------------------------- Team Tab -------------------------------- */

interface TeamMember {
  id: string
  name: string
  email: string
  role: string
  avatarColor: string | null
  isActive: boolean
  createdAt: string
}

function roleBadge(role: string) {
  if (role === 'admin') return <Badge variant="warning" className="gap-1 text-[10px]"><Crown className="h-3 w-3" />Admin</Badge>
  if (role === 'analyst') return <Badge variant="info" className="text-[10px]">Analyst</Badge>
  return <Badge variant="secondary" className="text-[10px]">Viewer</Badge>
}

function TeamTab() {
  const [me, setMe] = useState<ActiveUser | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [error, setError] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('viewer')
  const [inviting, setInviting] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)

  const isAdmin = me?.role === 'admin'

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [meRes, usersRes] = await Promise.all([
        fetch('/api/me', { cache: 'no-store' }),
        fetch('/api/users', { cache: 'no-store' }),
      ])
      if (!meRes.ok) throw new Error('Failed to load profile.')
      if (!usersRes.ok) {
        const body = await usersRes.json().catch(() => ({}))
        throw new Error(extractError(body, 'Failed to load team members.'))
      }
      const [meData, usersData] = await Promise.all([meRes.json(), usersRes.json()])
      setMe(meData as ActiveUser)
      setMembers((usersData as { items: TeamMember[] }).items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviting(true)
    setInviteUrl(null)
    try {
      const res = await fetch('/api/auth/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(extractError(data, 'Invitation failed.')); return }
      setInviteUrl(data.inviteUrl as string)
      toast.success('Invitation created. Copy the link to share.')
      setInviteEmail('')
    } catch {
      toast.error('Unable to connect to the server.')
    } finally {
      setInviting(false)
    }
  }

  async function handleRoleChange(id: string, role: string) {
    const res = await fetch(`/api/users/${id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { toast.error(extractError(data, 'Failed to update role.')); return }
    toast.success('Role updated.')
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, role } : m)))
  }

  async function handleDeactivate(id: string, name: string) {
    if (!window.confirm(`Deactivate ${name}? They will lose access immediately.`)) return
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { toast.error(extractError(data, 'Failed to deactivate user.')); return }
    toast.success('User deactivated.')
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, isActive: false } : m)))
  }

  if (loading) return showSkeleton ? <TableSkeleton rows={4} cols={4} /> : null
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="space-y-3">
      {isAdmin && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs flex items-center gap-2">
              <Mail className="h-3.5 w-3.5" />
              Invite Team Member
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-2 items-end">
              <div className="flex-1 w-full space-y-1.5">
                <Label htmlFor="invite-email" className="text-xs">Email</Label>
                <Input id="invite-email" type="email" placeholder="colleague@company.com" required
                  value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} disabled={inviting} />
              </div>
              <div className="w-full sm:w-32 space-y-1.5">
                <Label className="text-xs">Role</Label>
                <Select value={inviteRole} onValueChange={setInviteRole} disabled={inviting}>
                  <SelectTrigger className="w-full" size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">Viewer</SelectItem>
                    <SelectItem value="analyst">Analyst</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                size="sm"
                icon={inviting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
                disabled={inviting || !inviteEmail}
              >
                Send Invite
              </Button>
            </form>
            {inviteUrl && (
              <div className="mt-2.5 flex items-center gap-2 rounded-md border bg-muted/40 p-2">
                <code className="flex-1 truncate text-[11px] font-mono">{inviteUrl}</code>
                <Button size="sm" variant="outline" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => { void navigator.clipboard.writeText(inviteUrl); toast.success('Link copied.') }}>
                  Copy
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Member</TableHead>
                <TableHead className="text-xs">Role</TableHead>
                <TableHead className="text-xs">Status</TableHead>
                {isAdmin && <TableHead className="text-xs text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-7 w-7">
                        <AvatarFallback className="text-[10px] font-semibold text-white"
                          style={{ backgroundColor: m.avatarColor ?? 'oklch(0.55 0.18 250)' }}>
                          {initials(m.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate">{m.name}</div>
                        <div className="text-[11px] text-muted-foreground truncate">{m.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{roleBadge(m.role)}</TableCell>
                  <TableCell>
                    {m.isActive
                      ? <Badge variant="success" className="text-[10px]">Active</Badge>
                      : <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <Select value={m.role} onValueChange={(role) => void handleRoleChange(m.id, role)}>
                          <SelectTrigger size="sm" className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="viewer">Viewer</SelectItem>
                            <SelectItem value="analyst">Analyst</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive hover:text-destructive"
                          disabled={m.id === me?.userId || !m.isActive}
                          onClick={() => void handleDeactivate(m.id, m.name)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

/* --------------------------- Organization Tab ------------------------------ */

interface OrgInfo {
  id: string
  name: string
  slug: string
  brandingJson: string | null
  licensePlan: string | null
  licenseStatus: string
  licenseExpiresAt: string | null
}

interface LicenseInfo {
  key: string | null
  plan: string | null
  status: string
  validatedAt: string | null
  expiresAt: string | null
}

function planBadge(plan: string | null) {
  if (plan === 'enterprise') return <Badge variant="warning" className="text-[10px]">Enterprise</Badge>
  if (plan === 'pro') return <Badge variant="info" className="text-[10px]">Pro</Badge>
  if (plan === 'starter') return <Badge variant="secondary" className="text-[10px]">Starter</Badge>
  return <Badge variant="outline" className="text-[10px]">None</Badge>
}

function statusBadge(status: string) {
  if (status === 'valid') return <Badge variant="success" className="text-[10px]">Valid</Badge>
  if (status === 'expired') return <Badge variant="destructive" className="text-[10px]">Expired</Badge>
  if (status === 'invalid') return <Badge variant="destructive" className="text-[10px]">Invalid</Badge>
  if (status === 'suspended') return <Badge variant="destructive" className="text-[10px]">Suspended</Badge>
  return <Badge variant="secondary" className="text-[10px]">None</Badge>
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function OrgTab() {
  const [me, setMe] = useState<ActiveUser | null>(null)
  const [org, setOrg] = useState<OrgInfo | null>(null)
  const [license, setLicense] = useState<LicenseInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [error, setError] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [revalidating, setRevalidating] = useState(false)

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
                <Button size="sm" onClick={() => void handleSaveName()} disabled={savingName || editName.trim() === org.name}>
                  {savingName && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
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
              <div className="text-xs font-medium">{expiresAt ? fmtDate(expiresAt) : 'Lifetime'}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground mb-1">Last Validated</div>
              <div className="text-xs font-medium">{fmtDate(license?.validatedAt ?? null)}</div>
            </div>
          </div>
          {isAdmin && (
            <Button
              size="sm"
              variant="outline"
              icon={revalidating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              onClick={() => void handleRevalidate()}
              disabled={revalidating}
            >
              Revalidate
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}


/* --------------------------- Notifications Tab ---------------------------- */

interface NotificationConfigItem {
  id: string
  name: string
  type: string
  isActive: boolean
  configured: boolean
  maskedConfig: Record<string, unknown>
}

type NotifType = 'telegram' | 'email' | 'webhook'

function NotificationsTab() {
  const [configs, setConfigs] = useState<NotificationConfigItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const [type, setType] = useState<NotifType>('telegram')
  const [name, setName] = useState('')
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [botUsername, setBotUsername] = useState('')
  const [emailTo, setEmailTo] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookToken, setWebhookToken] = useState('')

  const load = () => {
    setLoading(true)
    fetch('/api/notifications', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load notification configs.')
        return r.json()
      })
      .then((d) => setConfigs(d.configs ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const reset = () => {
    setName(''); setBotToken(''); setChatId(''); setBotUsername('')
    setEmailTo(''); setWebhookUrl(''); setWebhookToken(''); setType('telegram')
  }

  const handleSave = async () => {
    let config: Record<string, unknown> | null = null
    if (type === 'telegram') {
      if (!botToken.trim() || !chatId.trim()) { toast.error('Bot token and chat ID are required.'); return }
      // Bot token format: 123456:ABC... — chat id: numeric or @channel
      config = { botToken: botToken.trim(), chatId: chatId.trim(), botUsername: botUsername.trim() }
    } else if (type === 'email') {
      if (!emailTo.trim()) { toast.error('Recipient email is required.'); return }
      config = { to: emailTo.trim() }
    } else {
      if (!webhookUrl.trim()) { toast.error('Webhook URL is required.'); return }
      // GitHub-style: {url, token} — receiver verifies via X-Signature-256 when signatureSecret set
      config = { url: webhookUrl.trim(), token: webhookToken.trim() || undefined, signatureSecret: undefined }
    }

    const finalName = name.trim() || `${type} config`
    setSaving(true)
    try {
      const res = await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: finalName, type, config }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        toast.success('Notification config saved.')
        setDialogOpen(false)
        reset()
        load()
      } else {
        const msg = typeof data?.error === 'string' ? data.error : data?.error?.message
        toast.error(msg || 'Failed to save notification config.')
      }
    } catch {
      toast.error('Network error while saving.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/notifications/${id}`, { method: 'DELETE' })
      if (res.ok) { toast.success('Notification config deleted.'); load() }
      else toast.error('Failed to delete notification config.')
    } catch {
      toast.error('Network error.')
    }
  }

  const toggleActive = async (c: NotificationConfigItem) => {
    try {
      const res = await fetch(`/api/notifications/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !c.isActive }),
      })
      if (res.ok) load()
      else toast.error('Failed to update config.')
    } catch {
      toast.error('Network error.')
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>Notification Channels</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Channels for scheduled-run results. Created configs appear in the Scheduler&apos;s channel selector.
            </p>
          </div>
          <Button size="sm" icon={<Bell className="h-3.5 w-3.5" />} onClick={() => { reset(); setDialogOpen(true) }}>
            Add Channel
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? <Delayed><TableSkeleton rows={3} /></Delayed> : error ? (
            <ErrorState message={error} onRetry={load} />
          ) : configs.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No channels yet. Add a Telegram bot, email recipient, or webhook.
            </div>
          ) : (
            <div className="space-y-2">
              {configs.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium truncate">{c.name}</span>
                      <Badge variant="outline" className="text-[10px] shrink-0">{c.type}</Badge>
                      {c.isActive ? (
                        <Badge variant="success" className="text-[10px] shrink-0">active</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] shrink-0">inactive</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 truncate font-mono">
                      {c.type === 'telegram' && (c.maskedConfig.botUsername ? `@${String(c.maskedConfig.botUsername)}` : 'Telegram bot')}
                      {c.type === 'email' && String(c.maskedConfig.to ?? 'email recipient')}
                      {c.type === 'webhook' && String(c.maskedConfig.url ?? 'webhook')}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => toggleActive(c)} title={c.isActive ? 'Deactivate' : 'Activate'}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => handleDelete(c.id)} title="Delete">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[480px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Notification Channel</DialogTitle>
            <DialogDescription>
              Receives scheduled-run results. Sensitive values are AES-encrypted at rest.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as NotifType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="telegram">Telegram Bot</SelectItem>
                  <SelectItem value="email">Email (Resend)</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Channel Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ops Alerts" />
            </div>

            {type === 'telegram' && (
              <>
                <div className="space-y-1.5">
                  <Label>Bot Token <span className="text-destructive">*</span></Label>
                  <Input value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456789:AAH... (from @BotFather)" className="font-mono text-xs" />
                  <p className="text-[11px] text-muted-foreground">
                    Get it from <span className="font-mono">@BotFather</span> → /newbot. Stored encrypted.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>Chat / Channel ID <span className="text-destructive">*</span></Label>
                  <Input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="123456789 or @mychannel" className="font-mono text-xs" />
                  <p className="text-[11px] text-muted-foreground">
                    For groups/channels use <span className="font-mono">@mybot</span> or message the bot once, then check <span className="font-mono">/getUpdates</span>.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>Bot Username (optional)</Label>
                  <Input value={botUsername} onChange={(e) => setBotUsername(e.target.value)} placeholder="@mybot or my_bot" className="font-mono text-xs" />
                </div>
              </>
            )}

            {type === 'email' && (
              <div className="space-y-1.5">
                <Label>Recipient Email <span className="text-destructive">*</span></Label>
                <Input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="ops@company.com" type="email" />
                <p className="text-[11px] text-muted-foreground">
                  Requires <span className="font-mono">RESEND_API_KEY</span> and <span className="font-mono">EMAIL_FROM</span> in .env.
                </p>
              </div>
            )}

            {type === 'webhook' && (
              <>
                <div className="space-y-1.5">
                  <Label>Webhook URL <span className="text-destructive">*</span></Label>
                  <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.example.com/ryasai" className="font-mono text-xs" />
                </div>
                <div className="space-y-1.5">
                  <Label>Bearer Token (optional)</Label>
                  <Input value={webhookToken} onChange={(e) => setWebhookToken(e.target.value)} placeholder="secret" type="password" className="font-mono text-xs" />
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button
                icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                onClick={handleSave}
                disabled={saving}
              >
                Save Channel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
