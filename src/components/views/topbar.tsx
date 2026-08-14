'use client'

import Image from 'next/image'
import { useState } from 'react'
import { LogOut, Menu, ShieldCheck, UserCircle, Building2, Settings as SettingsIcon, HelpCircle } from 'lucide-react'
import type React from 'react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ActiveUser } from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Helper function to get initials from name
function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

// Helper function to determine plan badge variant based on licensePlan
function getPlanBadgeVariant(plan: string | null): 'default' | 'secondary' | 'outline' {
  if (!plan) return 'outline'
  const planLower = plan.toLowerCase()
  if (planLower === 'enterprise') return 'default'
  if (planLower === 'pro') return 'default'
  if (planLower === 'starter') return 'secondary'
  return 'outline'
}

interface OrganizationInfo {
  name: string | null
  plan: string | null
}

export function Topbar({
  user,
  orgName,
  loading,
  onMenuClick,
}: {
  user?: ActiveUser | null
  orgName: string | null
  loading: boolean
  onMenuClick: () => void
}) {
  // Extract organization info from useActiveUser hook result
  const organization: OrganizationInfo = {
    name: orgName,
    plan: user?.plan || null,
  }

  const [aboutOpen, setAboutOpen] = useState(false)

  // Navigate to the settings view via the same custom event the sidebar uses,
  // so the shell swaps views without a full page reload.
  const goSettings = (tab?: string) => {
    window.dispatchEvent(new CustomEvent('navigate-view', { detail: { view: 'settings' } }))
    if (tab) window.dispatchEvent(new CustomEvent('settings-tab', { detail: { tab } }))
  }

  return (
    <header className="sticky top-0 z-30 h-14 border-b bg-background" suppressHydrationWarning>
      <div className="h-full px-4 md:px-6 flex items-center justify-between gap-3" suppressHydrationWarning>
        {/* Left section - Logo and Organization */}
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
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
              {loading ? (
                <div className="space-y-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-2.5 w-24" />
                </div>
              ) : (
                <>
                  <div 
                    className="text-sm font-semibold leading-tight truncate flex items-center gap-1.5"
                    suppressHydrationWarning
                  >
                    {organization.name || 'ryasai'}
                    {user?.plan && (
                      <Badge 
                        variant={getPlanBadgeVariant(user.plan)}
                        className="text-[9px] px-1.5 py-0 h-4.5"
                      >
                        {user.plan.toUpperCase()}
                      </Badge>
                    )}
                  </div>
                  <div 
                    className="text-xs text-muted-foreground leading-tight truncate flex items-center gap-1"
                    suppressHydrationWarning
                  >
                    {user?.email || 'Dedicated chatbot'}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right section - Guardrails badge, User, Actions */}
        <div className="flex items-center gap-2" suppressHydrationWarning>
          {/* Guardrails badge */}
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className="hidden sm:inline-flex h-7 items-center gap-1 border-emerald-200 bg-emerald-50/50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300 cursor-help"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                <span className="hidden lg:inline">Guardrails</span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>All queries are monitored by AI guardrails for safety and compliance</p>
            </TooltipContent>
          </Tooltip>

          {/* Loading state */}
          {loading && (
            <div className="hidden md:flex items-center gap-2">
              <Skeleton className="h-7 w-7 rounded-full" />
            </div>
          )}

          {/* User section */}
          {user && !loading && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button 
                  variant="ghost" 
                  size="sm"
                  className="h-auto px-2 gap-2 hover:bg-accent transition-colors"
                  aria-label="Account menu"
                >
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">
                      {getInitials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="hidden md:flex flex-col items-start leading-tight min-w-0 max-w-[220px]">
                    <div className="max-w-full truncate text-xs font-medium">{user.name}</div>
                    <div className="max-w-full truncate text-[10px] text-muted-foreground capitalize">{user.role}</div>
                  </div>
                </Button>
              </DropdownMenuTrigger>
              
              <DropdownMenuContent align="end" sideOffset={8} className="w-[200px]">
                {/* Organization header in dropdown */}
                <div className="px-2 py-1.5 border-b">
                  <div className="flex items-center gap-2 mb-1">
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium truncate">{orgName || 'Organization'}</span>
                  </div>
                  {user.plan && (
                    <Badge 
                      variant={getPlanBadgeVariant(user.plan)}
                      className="text-[9px]"
                    >
                      {user.plan.toUpperCase()}
                    </Badge>
                  )}
                </div>

                {/* Account menu items */}
                <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => goSettings('profile')}>
                  <UserCircle className="h-3.5 w-3.5" />
                  <span>Profile</span>
                </DropdownMenuItem>

                <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => goSettings()}>
                  <SettingsIcon className="h-3.5 w-3.5" />
                  <span>Settings</span>
                </DropdownMenuItem>

                <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setAboutOpen(true)}>
                  <HelpCircle className="h-3.5 w-3.5" />
                  <span>About</span>
                </DropdownMenuItem>
                
                <DropdownMenuSeparator />
                
                <DropdownMenuItem 
                  className="gap-2 cursor-pointer text-destructive focus:text-destructive"
                  onSelect={(e) => {
                    e.preventDefault()
                    handleSignOut()
                  }}
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Sign Out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {!user && !loading && (
            <UserCircle className="h-6 w-6 text-muted-foreground" />
          )}

          {/* Quick sign out button when logged in */}
          {user && !loading && (
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleSignOut}
                  aria-label="Sign Out"
                  title="Sign Out"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Sign Out</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* About dialog */}
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Image src="/logo.svg" alt="ryasai" width={22} height={22} className="rounded" />
              ryasai
            </DialogTitle>
            <DialogDescription className="text-left">
              Enterprise AI assistant — SQL, RAG, and REST routing with guardrails.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Organization</span>
              <span className="font-medium truncate">{orgName || '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Plan</span>
              <span className="font-medium capitalize">{user?.plan || '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Signed in as</span>
              <span className="font-medium truncate">{user?.email || '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Version</span>
              <span className="font-mono">{process.env.NEXT_PUBLIC_APP_VERSION || '0.4.0'}</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  )

  async function handleSignOut() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      window.location.reload()
    } catch (error) {
      console.error('Error signing out:', error)
      // Optionally show error notification to user
    }
  }
}
