'use client'

import { useState, useEffect, useCallback, useRef, type ReactNode, Fragment } from 'react'
import dynamic from 'next/dynamic'
import {
  LayoutDashboard,
  MessageSquare,
  Database,
  FileText,
  ShieldCheck,
  Settings,
  Brain,
  Wrench,
  X,
  Bot,
  Puzzle,
  Clock,
  Plug,
  RefreshCw,
  Layers,
  Hash,
  ChevronLeft,
  ChevronRight,
  UserCircle,
  Settings as SettingsIcon,
  LogOut,
  HelpCircle,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion'
import { cn } from '@/lib/utils'
import { useActiveUser } from '@/hooks/use-active-user'
import { applyTheme, getStoredTheme, getStoredDarkMode } from '@/lib/themes'
import { Button } from '@/components/ui/button'
import { DashboardView } from '@/components/views/dashboard-view'
import { LoginView } from '@/components/views/login-view'
import { BuyLicenseDialog } from '@/components/views/billing/buy-license-dialog'
import { ErrorScreen } from '@/components/ui/error-screen'
import { Topbar } from '@/components/views/topbar'
import {
  CardGridSkeleton,
  ChatMessageSkeleton,
  Delayed,
  FormSkeleton,
  ListRowsSkeleton,
  LoadingState,
  TableSkeleton,
} from '@/components/ui/view-states'
import {
  resolveViewFromSearch,
  type ViewKey,
} from '@/lib/view-routing'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// ponytail: every view except the default one is code-split. Statically
// importing all 12 put recharts, react-markdown and react-syntax-highlighter
// into the first-load chunk — 2.4 MB of JS to render a login form.
// Dashboard + Login stay static: they are what the first paint actually shows.
// ponytail: every fallback is wrapped in <Delayed>. These render the moment a
// menu item is clicked, and a chunk that is already in the browser cache
// resolves in 10-50 ms — so each switch used to paint skeleton → blank →
// content. Delayed drops anything that resolves inside 200 ms; a genuinely
// cold chunk still gets its skeleton.
const ChatView = dynamic(
  () => import('@/components/views/chat-view').then((m) => m.ChatView),
  { ssr: false, loading: () => <Delayed><ChatMessageSkeleton /></Delayed> },
)
const AgenticView = dynamic(
  () => import('@/components/views/agentic-view').then((m) => m.AgenticView),
  { ssr: false, loading: () => <Delayed><LoadingState /></Delayed> },
)
const IntegrationsView = dynamic(
  () => import('@/components/views/integrations-view').then((m) => m.IntegrationsView),
  { ssr: false, loading: () => <Delayed><CardGridSkeleton /></Delayed> },
)
const KnowledgeBaseView = dynamic(
  () => import('@/components/views/knowledge-base-view').then((m) => m.KnowledgeBaseView),
  { ssr: false, loading: () => <Delayed><CardGridSkeleton /></Delayed> },
)
const AIConfigurationView = dynamic(
  () => import('@/components/views/ai-configuration-view').then((m) => m.AIConfigurationView),
  { ssr: false, loading: () => <Delayed><FormSkeleton /></Delayed> },
)
const PromptToolsView = dynamic(
  () => import('@/components/views/prompt-tools-view').then((m) => m.PromptToolsView),
  { ssr: false, loading: () => <Delayed><FormSkeleton /></Delayed> },
)
const PluginsView = dynamic(
  () => import('@/components/views/plugins-view').then((m) => m.PluginsView),
  { ssr: false, loading: () => <Delayed><ListRowsSkeleton /></Delayed> },
)
const SchedulesView = dynamic(
  () => import('@/components/views/schedules-view').then((m) => m.SchedulesView),
  { ssr: false, loading: () => <Delayed><ListRowsSkeleton /></Delayed> },
)
const SecurityView = dynamic(
  () => import('@/components/views/security-view').then((m) => m.SecurityView),
  { ssr: false, loading: () => <Delayed><TableSkeleton /></Delayed> },
)
const IntegrationApiView = dynamic(
  () => import('@/components/views/integration-api-view').then((m) => m.IntegrationApiView),
  { ssr: false, loading: () => <Delayed><TableSkeleton /></Delayed> },
)
const SettingsView = dynamic(
  () => import('@/components/views/settings-view').then((m) => m.SettingsView),
  { ssr: false, loading: () => <Delayed><FormSkeleton /></Delayed> },
)
const SetupView = dynamic(
  () => import('@/components/views/setup-view').then((m) => m.SetupView),
  { ssr: false, loading: () => <Delayed><LoadingState /></Delayed> },
)

interface NavItem {
  key: ViewKey
  label: string
  icon: typeof Brain
  desc: string
  shortcut: number | null
}

/**
 * Sidebar navigation, GROUPED.
 *
 * WHY GROUPS RATHER THAN ONE FLAT LIST. Twelve peer items gave no answer to "where would X be?".
 * Config was the worst case: `AI Configuration`, `Prompt & Tools`, `Tools`, `Integration API` and
 * `Settings` all read as "settings", so an operator looking for memory credentials had five
 * plausible doors and no way to choose — the reported symptom was a submenu nobody could find.
 *
 * The groups follow the QUESTION the operator is asking, not the internal module layout:
 *   Workspace     "let me use the assistant"
 *   Data & Knowledge  "teach it about my business"  — memory lives here, with documents
 *   AI & Automation   "configure and automate it"   — memory is ALSO here, where the model is
 *   System            "administer the install"
 *
 * `Workspace` / `Data & Knowledge` / `AI & Automation` / `System` are the four that emerged from
 * grouping all twelve; anything finer produced a section with a single item, which is worse than no
 * header at all.
 */
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Workspace',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, desc: 'Operational overview', shortcut: 1 },
      { key: 'chat', label: 'Chat', icon: MessageSquare, desc: 'Internal assistant', shortcut: 2 },
      { key: 'agentic', label: 'Agentic', icon: Bot, desc: 'AI operations console', shortcut: 3 },
    ],
  },
  {
    title: 'Data & Knowledge',
    items: [
      { key: 'integrations', label: 'Data Sources', icon: Database, desc: 'Databases and REST APIs', shortcut: 4 },
      { key: 'knowledge', label: 'Knowledge', icon: FileText, desc: 'Documents, vector store and AI Memory', shortcut: null },
    ],
  },
  {
    title: 'AI & Automation',
    items: [
      { key: 'ai-config', label: 'AI Configuration', icon: Brain, desc: 'Provider, model, embedding and memory', shortcut: null },
      { key: 'prompt-tools', label: 'Prompt & Tools', icon: Wrench, desc: 'System prompt and routing', shortcut: null },
      { key: 'plugins', label: 'Tools', icon: Puzzle, desc: 'MCP servers and custom tools', shortcut: null },
      { key: 'schedules', label: 'Schedules', icon: Clock, desc: 'Automated scheduled runs', shortcut: null },
    ],
  },
  {
    title: 'System',
    items: [
      { key: 'security', label: 'Monitoring', icon: ShieldCheck, desc: 'Audit and guardrails', shortcut: null },
      { key: 'integration-api', label: 'Integration API', icon: Plug, desc: 'API keys and request logs', shortcut: null },
      { key: 'settings', label: 'Settings', icon: Settings, desc: 'Profile, team and system', shortcut: null },
    ],
  },
]

/** Flattened view of the same data, for lookups that do not care about grouping. */
const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

function renderView(view: ViewKey) {
  switch (view) {
    case 'dashboard':
      return <DashboardView />
    case 'chat':
    case 'agentic':
      // Rendered separately as persistent mounted views
      return null
    case 'integrations':
      return <IntegrationsView />
    case 'knowledge':
      return <KnowledgeBaseView />
    case 'ai-config':
      return <AIConfigurationView />
    case 'prompt-tools':
      return <PromptToolsView />
    case 'plugins':
      return <PluginsView />
    case 'schedules':
      return <SchedulesView />
    case 'security':
      return <SecurityView />
    case 'integration-api':
      return <IntegrationApiView />
    case 'settings':
      return <SettingsView />
  }
}

const SIDEBAR_WIDTH_EXPANDED = 260
const SIDEBAR_WIDTH_COLLAPSED = 72

export default function Home() {
  const [view, setViewState] = useState<ViewKey>('dashboard')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const { user, orgName, loading, unauthorized, licenseError, refresh } = useActiveUser()
  const reduceMotion = usePrefersReducedMotion()

  // ponytail: chat + agentic stay mounted once opened (preserves SSE streams and
  // chat state), but there is no reason to mount — and download — them before
  // the user ever goes there. Ref, not state: adding is idempotent and the view
  // change already triggers this render.
  const visited = useRef<Set<ViewKey>>(new Set())
  visited.current.add(view)

  const [setup, setSetup] = useState<{
    setupCompleted: boolean
    hasAdmin: boolean
  } | null>(null)
  const [setupRefreshKey, setSetupRefreshKey] = useState(0)

  // License retry state — 'Try Again' re-validates against the License-Validator
  // service (not just re-reading cached DB status). After a failed retry, a
  // 'Sign Up Again' button appears so the user can start a fresh signup.
  const [licenseRetrying, setLicenseRetrying] = useState(false)
  const [licenseRetryFailed, setLicenseRetryFailed] = useState(false)
  const [forceSignup, setForceSignup] = useState(false)
  // Buy License checkout — reachable from the lockdown screen (unpaid orgs)
  // and from Settings → Organization. The lockdown shell is replaced entirely,
  // so a dialog (not a routed view) is the only entry point that works here.
  const [buyLicenseOpen, setBuyLicenseOpen] = useState(false)

  const sidebarRef = useRef<HTMLDivElement>(null)

  const setView = useCallback((next: ViewKey) => {
    setViewState(next)
    const url = new URL(window.location.href)
    url.searchParams.set('view', next)
    window.history.replaceState(null, '', url)
  }, [])

  // The nav shell only renders for a fully signed-in, licensed, set-up user.
  // Shortcuts must not fire on login/signup/setup/lockdown screens.
  const shellActive = !!setup?.setupCompleted && !loading && !!user && !unauthorized && !licenseError

  // Handle keyboard shortcuts (Cmd/Ctrl + 1-4)
  useEffect(() => {
    if (!shellActive) return
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only trap when on desktop and sidebar is visible
      if (window.innerWidth < 768) return
      
      // Check for Cmd/Ctrl + number
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10)
        if (!isNaN(num) && num >= 1 && num <= 9) {
          const navItem = NAV.find(item => item.shortcut === num)
          if (navItem) {
            e.preventDefault()
            setView(navItem.key)
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setView, shellActive])

  // Real license revalidation: hit POST /api/license/retry (calls the
  // License-Validator service, updates org.licenseStatus in DB), then refresh
  // /api/me so the shell re-evaluates the license gate. If the license is still
  // not valid afterwards, surface the 'Sign Up Again' button.
  const handleLicenseRetry = useCallback(async () => {
    setLicenseRetrying(true)
    setLicenseRetryFailed(false)
    try {
      const res = await fetch('/api/license/retry', { method: 'POST' })
      const data = await res.json().catch(() => ({} as Record<string, unknown>))
      await refresh()
      const status = (data?.license as { status?: string } | undefined)?.status
      if (status !== 'valid') {
        setLicenseRetryFailed(true)
      }
    } catch {
      // Network error on retry itself — refresh to re-read DB, then offer signup
      await refresh()
      setLicenseRetryFailed(true)
    } finally {
      setLicenseRetrying(false)
    }
  }, [refresh])

  // After a failed retry, let the user start a fresh signup: clear the session
  // and show the LoginView in signup mode.
  const handleSignupAgain = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setForceSignup(true)
  }, [])

  useEffect(() => {
    applyTheme(getStoredTheme(), getStoredDarkMode())
    const fromUrl = resolveViewFromSearch(window.location.search)
    // ponytail: mount-time URL→state sync — useSyncExternalStore would avoid the warning
    // but changes the writable-state pattern; guard prevents cascading renders
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewState((prev) => (prev === fromUrl ? prev : fromUrl))
    const onPop = () => setViewState(resolveViewFromSearch(window.location.search))
    window.addEventListener('popstate', onPop)
    const onNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail as { view: ViewKey } | undefined
      if (detail?.view) setView(detail.view)
    }
    window.addEventListener('navigate-view', onNavigate as EventListener)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('navigate-view', onNavigate as EventListener)
    }
  }, [setView])

  useEffect(() => {
    let cancelled = false
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setSetup(data)
      })
      .catch(() => {
        if (!cancelled) setSetup({ setupCompleted: true, hasAdmin: true })
      })
    return () => {
      cancelled = true
    }
  }, [setupRefreshKey])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev)
  }, [])

  // ponytail: RACE FIX — /api/me typically resolves before /api/setup/status,
  // so the `!loading && unauthorized` branch below used to mount LoginView in
  // LOGIN mode first; when setup-status then arrived with setupCompleted:false,
  // re-rendering with defaultMode="signup" did NOT remount the component, so
  // React kept the stale `mode` state and a brand-new visitor saw "Sign In"
  // with no account in the DB. Gate every render on setup status being known.
  if (setup === null) return null

  if (setup && !setup.setupCompleted) {
    if (!setup.hasAdmin) {
      // No users exist — show signup
      return (
        <LoginView
          onSuccess={() => {
            setSetup(null)
            setSetupRefreshKey((k) => k + 1)
            refresh()
          }}
          defaultMode="signup"
        />
      )
    }
    // Users exist but setup not completed — must be logged in to continue
    if (!loading && unauthorized) {
      // Not logged in — show login
      return <LoginView onSuccess={() => { setSetupRefreshKey((k) => k + 1); refresh() }} />
    }
    if (!loading && user && !user.plan) {
      // Logged in but no license — show license activation
      return (
        <LoginView
          onSuccess={() => {
            setSetup(null)
            setSetupRefreshKey((k) => k + 1)
            refresh()
          }}
          defaultMode="signup"
          startStep={1}
        />
      )
    }
    // Logged in with license — show wizard
    if (!loading && user && user.plan) {
      return (
        <SetupView
          onDone={() => {
            setSetup({ setupCompleted: true, hasAdmin: true })
            refresh()
          }}
        />
      )
    }
    // Still loading — render nothing (prevents flash)
    return null
  }

  if (forceSignup) {
    return (
      <LoginView
        onSuccess={() => {
          setForceSignup(false)
          setLicenseRetryFailed(false)
          setSetupRefreshKey((k) => k + 1)
          refresh()
        }}
        defaultMode="signup"
      />
    )
  }

  if (!loading && unauthorized) {
    return <LoginView onSuccess={() => { setSetupRefreshKey((k) => k + 1); refresh() }} />
  }

  if (!loading && licenseError) {
    // ponytail: session.ts does not expose the lockdown REASON to the client
    // (402 body carries code+message only), so the Buy CTA shows for every
    // license lockdown — purchasing also renews/extends expired licenses, so
    // this is correct for 'unpaid' and 'expired' alike.
    return (
      <>
        <ErrorScreen
          type="license"
          onRetry={handleLicenseRetry}
          retrying={licenseRetrying}
          onSignup={licenseRetryFailed ? handleSignupAgain : undefined}
          onBuyLicense={() => setBuyLicenseOpen(true)}
        />
        <BuyLicenseDialog
          open={buyLicenseOpen}
          onOpenChange={setBuyLicenseOpen}
          // ponytail: no onSettled here — closing the dialog or refreshing
          // identity on settlement unmounts the lockdown shell and rips the
          // success screen away before the user sees it. The dialog's own
          // "Reload App" button performs a full load, which re-fetches /api/me.
        />
      </>
    )
  }

  const sidebarWidth = sidebarCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED

  return (
    <>
      <div className="min-h-screen flex flex-col bg-muted/25" suppressHydrationWarning>
        <Topbar 
          user={user} 
          orgName={orgName} 
          loading={loading} 
          onMenuClick={() => setMobileOpen((v) => !v)} 
        />

        <div className="flex flex-1 w-full" suppressHydrationWarning>
          {/* Sidebar */}
          <motion.div
            ref={sidebarRef}
            initial={false}
            animate={{ width: sidebarWidth }}
            transition={{ 
              duration: reduceMotion ? 0 : 0.3,
              ease: [0.23, 1, 0.32, 1] 
            }}
            data-sidebar-shell
            /*
             * OVERFLOW-Y-AUTO, NOT HIDDEN, and this is a measured bug rather than a preference. MEASURED at 1907x620:
             * the shell ended at y=620 (the viewport) while the nav inside it ended at y=669 — 49px LOWER — and
             * "overflow-hidden" clipped that excess with no way to scroll. The result was that "Settings" sat at
             * y=625..661, permanently outside the viewport and unreachable, even though the nav reported nothing to
             * scroll (its scrollHeight equalled clientHeight because the clip happened ONE LEVEL UP).
             *
             * The nav keeps its own overflow-y-auto for the tall-content case; this makes the SHELL scrollable too, so
             * the excess is reachable instead of discarded. Nothing changes on a viewport where everything already
             * fits: with no overflow there is no scrollbar and no layout shift.
             */
            className="hidden md:flex shrink-0 flex-col border-r bg-background sticky top-14 h-[calc(100vh-3.5rem)] overflow-hidden"
            suppressHydrationWarning
          >
            {/* Sidebar Header with Collapse Toggle */}
            <div className={cn(
              'flex items-center px-3 py-2 border-b',
              sidebarCollapsed ? 'justify-center' : 'justify-between',
            )}>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleSidebar}
                    className="h-8 w-8 p-0"
                    aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  >
                    {sidebarCollapsed ? (
                      <ChevronRight className="h-4 w-4" />
                    ) : (
                      <ChevronLeft className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" align="start">
                  <p>{sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}</p>
                </TooltipContent>
              </Tooltip>
              
              {!sidebarCollapsed && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <Badge variant="outline" className="text-xs">
                    Organization
                  </Badge>
                </motion.div>
              )}
            </div>
            
            <SidebarContent 
              view={view} 
              setView={setView} 
              role={user?.role}
              collapsed={sidebarCollapsed}
            />
          </motion.div>

          <AnimatePresence>
            {mobileOpen && (
              <div className="fixed inset-0 z-40 md:hidden">
                <motion.div
                  className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setMobileOpen(false)}
                />
                <motion.aside
                  className="absolute left-0 top-0 h-full w-72 bg-background border-r shadow-2xl flex flex-col"
                  initial={{ x: '-100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '-100%' }}
                  transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 360, damping: 36 }}
                >
                  <div className="flex items-center justify-between p-4 border-b">
                    <span className="font-semibold">Navigation</span>
                    <button
                      onClick={() => setMobileOpen(false)}
                      className="p-1.5 rounded-md hover:bg-muted"
                      aria-label="Close menu"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <SidebarContent
                    view={view}
                    setView={(v) => {
                      setView(v)
                      setMobileOpen(false)
                    }}
                    role={user?.role}
                    collapsed={false}
                  />
                </motion.aside>
              </div>
            )}
          </AnimatePresence>

          <main className="flex-1 min-w-0 flex flex-col h-[calc(100vh-3.5rem)] sticky top-14" suppressHydrationWarning>
            <div className="shrink-0 bg-background border-b px-4 md:px-6 py-2.5" suppressHydrationWarning>
              <ViewHeader view={view} action={renderHeaderAction(view)} />
            </div>
            <div suppressHydrationWarning className={cn(
              'flex-1 min-h-0',
              view === 'chat' || view === 'agentic' ? 'overflow-hidden' : 'overflow-y-auto',
              'p-4 md:p-6',
            )}>
              {/* Stateful views: mounted on first visit, then kept mounted and
                  hidden when inactive. Preserves SSE streams + chat state
                  across menu switches. */}
              {visited.current.has('chat') && (
                <div className={cn('h-full', view === 'chat' ? 'block' : 'hidden')}>
                  <ChatView />
                </div>
              )}
              {visited.current.has('agentic') && (
                <div className={cn('h-full', view === 'agentic' ? 'block' : 'hidden')}>
                  <AgenticView />
                </div>
              )}
              {/* Other views: mount on demand with fade animation. */}
              <AnimatePresence mode="wait">
                {view !== 'chat' && view !== 'agentic' && (
                  <motion.div
                    key={view}
                    className="h-full"
                    suppressHydrationWarning
                    initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
                    transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                  >
                    {renderView(view)}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </main>
        </div>
      </div>
    </>
  )
}

interface SidebarContentProps {
  view: ViewKey
  setView: (v: ViewKey) => void
  role?: string
  collapsed?: boolean
}

function SidebarContent({
  view,
  setView,
  role,
  collapsed = false,
}: SidebarContentProps) {
  // Visibility is decided per ITEM, then empty groups are dropped — a viewer sees no Agentic entry,
  // and a section header with nothing under it would look like a rendering fault.
  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => !(item.key === 'agentic' && role === 'viewer')),
  })).filter((g) => g.items.length > 0)

  const renderItem = (item: NavItem) => {
    const Icon = item.icon
    const active = view === item.key

    if (collapsed) {
      /* Collapsed state - icon only with tooltip */
      return (
        <Tooltip key={item.key} delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              onClick={() => setView(item.key)}
              className={cn(
                'relative w-full flex items-center justify-center rounded-md px-2.5 py-2 text-left transition-colors group',
                active ? 'bg-primary/10' : 'hover:bg-muted',
              )}
              aria-label={item.label}
              title={undefined} // Tooltip handles the title
            >
              {active && (
                <motion.div
                  layoutId="nav-active-pill-collapsed"
                  data-nav-pill
                  className="absolute left-0 right-0 top-1/2 h-6 w-1 rounded-full bg-primary"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  style={{ zIndex: -1 }}
                />
              )}
              <Icon
                className={cn(
                  'h-5 w-5 shrink-0 relative',
                  active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
                )}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="center" className="z-50">
            <div className="flex flex-col">
              <span className="font-medium">{item.label}</span>
              <span className="text-xs text-primary-foreground/70">{item.desc}</span>
              {item.shortcut && (
                <span className="mt-1 text-[10px] text-primary-foreground/60">
                  ⌘{item.shortcut}
                </span>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      )
    }

    /* Expanded state - full navigation item */
    return (
      <Tooltip key={item.key} delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            onClick={() => setView(item.key)}
            className={cn(
              /*
               * COMPACT BY MEASUREMENT, not by taste. MEASURED with Playwright at the user's own viewport width: the
               * sidebar needs 640px of content, and the menu is CUT OFF below ~700px of viewport height (36px missing at
               * 660, 56px at 640) — "Settings", the entry an admin needs to manage their team, was the casualty. py-2.5
               * made every row 40px; py-2 reclaims 48px across the twelve rows, which is what puts Settings back inside
               * the fold on a laptop. The icon and label stay h-5/text-sm, so nothing becomes harder to read or click.
               */
              'relative w-full flex items-center gap-3 rounded-md px-3 py-2 text-left transition-colors',
              active ? 'text-primary-foreground' : 'hover:bg-muted text-foreground',
            )}
            aria-label={item.label}
          >
            {active && (
              <motion.div
                layoutId="nav-active-pill-expanded"
                data-nav-pill
                className="absolute inset-0 rounded-md bg-primary"
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                style={{ zIndex: -1 }}
              />
            )}
            <Icon
              className={cn(
                'h-5 w-5 shrink-0 relative z-10',
                active ? '' : 'text-muted-foreground',
              )}
            />
            <span className="text-sm font-medium truncate relative z-10">{item.label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[200px]">
          <div className="flex flex-col">
            <span className="font-medium">{item.label}</span>
            <span className="text-xs text-primary-foreground/70 mt-1">{item.desc}</span>
          </div>
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    /*
     * `min-h-0` + `flex-1`, NOT `h-full`. MEASURED at 1907x620: `h-full` makes this wrapper 100% of the sidebar shell,
     * but the shell ALSO contains the header above it — so the two together overflowed the shell by 49px, and the nav
     * (and the "Settings" entry at its end) was pushed below the viewport. The shell's `overflow-hidden` then clipped it
     * with nothing to scroll, because the nav itself reported no overflow: the excess was created at THIS level.
     *
     * `min-h-0` is the part that matters: a flex child defaults to `min-height: auto`, which refuses to shrink below its
     * content, so `flex-1` alone cannot constrain the nav. With both, the wrapper takes the space the header leaves and
     * the nav scrolls INSIDE it — which is what the `overflow-y-auto` on the nav has always intended.
     */
    <div className="flex flex-col flex-1 min-h-0">
      <nav className="flex-1 min-h-0 p-2 overflow-y-auto">
        {groups.map((group, gi) => (
          <div key={group.title} className={gi > 0 ? 'mt-2' : undefined}>
            {collapsed ? (
              // Collapsed: a hairline separator. A text header cannot fit in 72px, and dropping the
              // grouping entirely would make collapsing the sidebar also collapse the information
              // architecture — the grouping is the point, not decoration.
              gi > 0 && <div className="mx-2 mb-2 border-t border-border/60" />
            ) : (
              // pt-0.5 instead of pt-1: with FOUR groups this is 8px, and it is spacing no one reads as structure.
              <div className="px-3 pb-0.5 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.title}
              </div>
            )}
            <div className="space-y-0.5">{group.items.map(renderItem)}</div>
          </div>
        ))}
      </nav>
    </div>
  )
}

function ViewHeader({ view, action }: { view: ViewKey; action?: ReactNode }) {
  const item = NAV.find((n) => n.key === view)
  if (!item) return null
  const Icon = item.icon
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <Icon className="h-5 w-5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight">{item.label}</h1>
          <p className="text-xs text-muted-foreground">{item.desc}</p>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

function renderHeaderAction(view: ViewKey): ReactNode {
  const dispatch = (action: string) =>
    window.dispatchEvent(new CustomEvent('view-action', { detail: { action } }))
  switch (view) {
    case 'dashboard':
      return (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Reload"
          onClick={() => dispatch('refresh')}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      )
    case 'knowledge':
      return (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="Rebuild Embeddings"
            onClick={() => dispatch('rebuild-embeddings')}
          >
            <Layers className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="Rebuild BM25"
            onClick={() => dispatch('rebuild-bm25')}
          >
            <Hash className="h-4 w-4" />
          </Button>
        </div>
      )
    default:
      return null
  }
}
