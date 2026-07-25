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
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadingState, ErrorState } from '@/components/ui/view-states'
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
import { cn } from '@/lib/utils'
import type { ActiveUser } from '@/lib/types'
import { THEMES, type ThemeId, setTheme } from '@/lib/themes'

const initials = (name: string) =>
  name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()

export function SettingsView() {
  const [tab, setTab] = useState('profile')

  return (
    <Tabs value={tab} onValueChange={setTab} className="w-full">
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
      </TabsList>

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
    </Tabs>
  )
}

/* ------------------------------- Profile Tab ------------------------------- */

function ProfileTab() {
  const [user, setUser] = useState<ActiveUser | null>(null)
  const [loading, setLoading] = useState(true)
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
    return <LoadingState />
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
              onClick={() => handleDark(false)}
              className="h-8"
            >
              <Sun className="h-3.5 w-3.5" />
              Light
            </Button>
            <Button
              size="sm"
              variant={dark ? 'default' : 'outline'}
              onClick={() => handleDark(true)}
              className="h-8"
            >
              <Moon className="h-3.5 w-3.5" />
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
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Terminal className="h-3.5 w-3.5" />
            <span>Reset development data:</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">./reset.sh</code>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

