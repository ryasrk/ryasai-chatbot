'use client'

import Image from 'next/image'
import { LogOut, Menu, ShieldCheck, UserCircle } from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { ActiveUser } from '@/lib/types'

export function Topbar({
  user,
  orgName,
  loading,
  onMenuClick,
}: {
  user: ActiveUser | null
  orgName: string | null
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
    <header className="sticky top-0 z-30 h-14 border-b bg-background" suppressHydrationWarning>
      <div className="h-full px-4 md:px-6 flex items-center justify-between gap-3" suppressHydrationWarning>
        <div className="flex items-center gap-2 md:gap-3 min-w-0" suppressHydrationWarning>
          <button
            onClick={onMenuClick}
            className="md:hidden p-1.5 rounded-md hover:bg-muted"
            aria-label="Open menu"
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
            <div className="min-w-0 hidden sm:block" suppressHydrationWarning>
              <div className="text-sm font-semibold leading-tight truncate" suppressHydrationWarning>{orgName ?? 'ryasai'}</div>
              <div className="text-[11px] text-muted-foreground leading-tight truncate" suppressHydrationWarning>
                {user?.email ?? 'Dedicated chatbot'}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2" suppressHydrationWarning>
          <Badge
            variant="outline"
            className="hidden sm:inline-flex h-7 items-center gap-1 border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
          >
            <ShieldCheck className="h-3 w-3" />
            Guardrails
          </Badge>

          <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1" suppressHydrationWarning>
            {loading ? (
              <div className="flex items-center gap-2">
                <Skeleton className="h-7 w-7 rounded-full" />
                <div className="hidden md:block space-y-1">
                  <Skeleton className="h-2.5 w-20" />
                  <Skeleton className="h-2 w-16" />
                </div>
              </div>
            ) : user ? (
              <>
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="bg-primary text-[11px] font-semibold text-primary-foreground">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="hidden md:block text-left leading-tight">
                  <div className="max-w-[160px] truncate text-xs font-medium">{user.name}</div>
                  <div className="text-[10px] text-muted-foreground capitalize">{user.role}</div>
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
              aria-label="Sign Out"
              title="Sign Out"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}
