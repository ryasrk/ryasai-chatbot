'use client'

import Image from 'next/image'
import { Loader2, LogOut, Menu, ShieldCheck, UserCircle } from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ActiveUser } from '@/lib/types'

export function Topbar({
  user,
  loading,
  onMenuClick,
}: {
  user: ActiveUser | null
  loading: boolean
  onMenuClick: () => void
}) {
  const initials = (name: string) =>
    name
      .split(' ')
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase()

  return (
    <header className="sticky top-0 z-30 h-14 border-b bg-background">
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
            <Image
              src="/logo.svg"
              alt="ryasai"
              width={32}
              height={32}
              className="h-8 w-8 rounded-md shrink-0"
              priority
            />
            <div className="min-w-0 hidden sm:block">
              <div className="text-sm font-semibold leading-tight truncate">ryasai</div>
              <div className="text-[11px] text-muted-foreground leading-tight truncate">
                {user?.companyName ?? 'Dedicated chatbot'}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="hidden sm:inline-flex h-7 items-center gap-1 border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
          >
            <ShieldCheck className="h-3 w-3" />
            Guardrails
          </Badge>

          <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1">
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : user ? (
              <>
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="bg-primary text-[11px] font-semibold text-primary-foreground">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="hidden md:block text-left leading-tight">
                  <div className="max-w-[160px] truncate text-xs font-medium">{user.name}</div>
                  <div className="text-[10px] text-muted-foreground">Admin</div>
                </div>
              </>
            ) : (
              <UserCircle className="h-6 w-6 text-muted-foreground" />
            )}
          </div>

          {user && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST' })
                window.location.reload()
              }}
              aria-label="Keluar"
              title="Keluar"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}
