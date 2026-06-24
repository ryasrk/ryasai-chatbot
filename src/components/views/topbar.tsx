'use client'

import { useState, useRef, useEffect } from 'react'
import { Brain, ChevronDown, UserCircle, ShieldCheck, Menu, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useActiveUser } from '@/hooks/use-active-user'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import type { ActiveUser } from '@/lib/types'

const ROLE_STYLES: Record<string, string> = {
  admin: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  manager: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  staff: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
}

export function Topbar({
  user,
  loading,
  onMenuClick,
}: {
  user: ActiveUser | null
  loading: boolean
  onMenuClick: () => void
}) {
  const { companyUsers, switchUser } = useActiveUser()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  const initials = (name: string) =>
    name
      .split(' ')
      .map((n) => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase()

  return (
    <header className="sticky top-0 z-30 h-14 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="h-full px-4 md:px-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <button
            onClick={onMenuClick}
            className="md:hidden p-1.5 rounded-md hover:bg-muted"
            aria-label="Buka menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary text-primary-foreground shrink-0">
              <Brain className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0 hidden sm:block">
              <div className="text-sm font-semibold leading-tight truncate">AI Internal Assistant</div>
              <div className="text-[11px] text-muted-foreground leading-tight truncate">
                {user?.companyName ?? 'Enterprise'}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="hidden sm:inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
          >
            <ShieldCheck className="h-3 w-3" />
            Guardrails Aktif
          </Badge>

          <div className="relative" ref={ref}>
            <button
              onClick={() => setOpen((v) => !v)}
              className="flex items-center gap-2 rounded-full pl-1 pr-2 py-1 hover:bg-muted transition-colors"
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : user ? (
                <>
                  <Avatar className="h-7 w-7">
                    <AvatarFallback
                      className="text-[11px] font-semibold text-white"
                      style={{ backgroundColor: 'var(--avatar-color, oklch(0.55 0.18 250))' }}
                    >
                      {initials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="hidden md:block text-left leading-tight">
                    <div className="text-xs font-medium truncate max-w-[140px]">{user.name}</div>
                    <div className="text-[10px] text-muted-foreground capitalize">{user.role}</div>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </>
              ) : (
                <UserCircle className="h-6 w-6 text-muted-foreground" />
              )}
            </button>

            {open && !loading && user && (
              <div className="absolute right-0 mt-2 w-64 rounded-lg border bg-popover shadow-lg p-1.5 z-50">
                <div className="px-2 py-1.5 border-b mb-1">
                  <div className="text-[11px] text-muted-foreground">Ganti pengguna aktif (demo)</div>
                </div>
                {companyUsers.map((u) => (
                  <button
                    key={u.userId}
                    onClick={async () => {
                      await switchUser(u.userId)
                      setOpen(false)
                    }}
                    className={cn(
                      'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted transition-colors',
                      u.userId === user.userId && 'bg-muted',
                    )}
                  >
                    <Avatar className="h-6 w-6">
                      <AvatarFallback
                        className="text-[10px] font-semibold text-white"
                        style={{ backgroundColor: 'var(--avatar-color, oklch(0.55 0.18 250))' }}
                      >
                        {initials(u.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{u.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{u.email}</div>
                    </div>
                    <span
                      className={cn(
                        'text-[9px] px-1.5 py-0.5 rounded-full font-medium capitalize',
                        ROLE_STYLES[u.role],
                      )}
                    >
                      {u.role}
                    </span>
                  </button>
                ))}
                <div className="px-2 py-1.5 mt-1 border-t text-[10px] text-muted-foreground">
                  RBAC: admin / manager / staff
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
