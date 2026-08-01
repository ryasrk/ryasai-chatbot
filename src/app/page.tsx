'use client'

import { useState, useEffect, useCallback, type ReactNode } from 'react'
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
} from 'lucide-react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useActiveUser } from '@/hooks/use-active-user'
import { applyTheme, getStoredTheme, getStoredDarkMode } from '@/lib/themes'
import { Button } from '@/components/ui/button'
import { DashboardView } from '@/components/views/dashboard-view'
import { ChatView } from '@/components/views/chat-view'
import { IntegrationsView } from '@/components/views/integrations-view'
import { KnowledgeBaseView } from '@/components/views/knowledge-base-view'
import { SecurityView } from '@/components/views/security-view'
import { SettingsView } from '@/components/views/settings-view'
import { AIConfigurationView } from '@/components/views/ai-configuration-view'
import { PromptToolsView } from '@/components/views/prompt-tools-view'
import { IntegrationApiView } from '@/components/views/integration-api-view'
import { AgenticView } from '@/components/views/agentic-view'
import { PluginsView } from '@/components/views/plugins-view'
import { SchedulesView } from '@/components/views/schedules-view'
import { LoginView } from '@/components/views/login-view'
import { SetupView } from '@/components/views/setup-view'
import { Topbar } from '@/components/views/topbar'
import {
  resolveViewFromSearch,
  type ViewKey,
} from '@/lib/view-routing'

const NAV: { key: ViewKey; label: string; icon: typeof Brain; desc: string }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, desc: 'Operational overview' },
  { key: 'chat', label: 'Chat', icon: MessageSquare, desc: 'Internal assistant' },
  { key: 'agentic', label: 'Agentic', icon: Bot, desc: 'AI operations console' },
  { key: 'integrations', label: 'Data Sources', icon: Database, desc: 'Databases and REST APIs' },
  { key: 'knowledge', label: 'Knowledge', icon: FileText, desc: 'Documents and RAG' },
  { key: 'ai-config', label: 'AI Configuration', icon: Brain, desc: 'Provider, model, embedding' },
  { key: 'prompt-tools', label: 'Prompt & Tools', icon: Wrench, desc: 'System prompt and routing' },
  { key: 'plugins', label: 'Tools', icon: Puzzle, desc: 'MCP servers and custom tools' },
  { key: 'schedules', label: 'Schedules', icon: Clock, desc: 'Automated scheduled runs' },
  { key: 'security', label: 'Monitoring', icon: ShieldCheck, desc: 'Audit and guardrails' },
  { key: 'integration-api', label: 'Integration API', icon: Plug, desc: 'API keys and request logs' },
  { key: 'settings', label: 'Settings', icon: Settings, desc: 'Admin and configuration' },
]

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

export default function Home() {
  const [view, setViewState] = useState<ViewKey>('dashboard')
  const [mobileOpen, setMobileOpen] = useState(false)
  const { user, orgName, loading, unauthorized, refresh } = useActiveUser()
  const reduceMotion = useReducedMotion()

  const [setup, setSetup] = useState<{
    setupCompleted: boolean
    hasAdmin: boolean
  } | null>(null)

  const setView = useCallback((next: ViewKey) => {
    setViewState(next)
    const url = new URL(window.location.href)
    url.searchParams.set('view', next)
    window.history.replaceState(null, '', url)
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
  }, [])

  if (setup && !setup.setupCompleted) {
    if (!setup.hasAdmin) {
      // No users exist — show signup (org + license + admin creation)
      return (
        <LoginView
          onSuccess={() => {
            // After signup, re-fetch setup status to transition to wizard
            setSetup(null)
            refresh()
          }}
          defaultMode="signup"
        />
      )
    }
    // Admin exists but setup not completed — show wizard
    return (
      <SetupView
        onDone={() => {
          setSetup({ setupCompleted: true, hasAdmin: true })
          refresh()
        }}
      />
    )
  }

  if (!loading && unauthorized) {
    return <LoginView onSuccess={refresh} />
  }

  return (
    <>
      <div className="min-h-screen flex flex-col bg-muted/25" suppressHydrationWarning>
        <Topbar user={user} orgName={orgName} loading={loading} onMenuClick={() => setMobileOpen((v) => !v)} />

        <div className="flex flex-1 w-full" suppressHydrationWarning>
          <aside
            suppressHydrationWarning
            className={cn(
              'hidden md:flex md:w-52 lg:w-60 shrink-0 flex-col border-r bg-background',
              'sticky top-[57px] h-[calc(100vh-57px)]',
            )}
          >
            <SidebarContent view={view} setView={setView} />
          </aside>

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
                  />
                </motion.aside>
              </div>
            )}
          </AnimatePresence>

          <main className="flex-1 min-w-0 flex flex-col h-[calc(100vh-57px)] sticky top-[57px]" suppressHydrationWarning>
            <div className="shrink-0 bg-background border-b px-4 md:px-6 py-2.5" suppressHydrationWarning>
              <ViewHeader view={view} action={renderHeaderAction(view)} />
            </div>
            <div suppressHydrationWarning className={cn(
              'flex-1 min-h-0',
              view === 'chat' || view === 'agentic' ? 'overflow-hidden' : 'overflow-y-auto',
              'p-4 md:p-6',
            )}>
              {/* Stateful views: always mounted, hidden when inactive.
                  Preserves SSE streams + chat state across menu switches. */}
              <div className={cn('h-full', view === 'chat' ? 'block' : 'hidden')}>
                <ChatView />
              </div>
              <div className={cn('h-full', view === 'agentic' ? 'block' : 'hidden')}>
                <AgenticView />
              </div>
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

function SidebarContent({
  view,
  setView,
}: {
  view: ViewKey
  setView: (v: ViewKey) => void
}) {
  return (
    <div className="flex flex-col h-full">
      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => {
          const Icon = item.icon
          const active = view === item.key
          return (
            <button
              key={item.key}
              onClick={() => setView(item.key)}
              className={cn(
                'relative w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                active ? 'text-primary-foreground' : 'hover:bg-muted text-foreground',
              )}
            >
              {active && (
                <motion.div
                  layoutId="nav-active-pill"
                  className="absolute inset-0 rounded-md bg-primary"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  style={{ zIndex: -1 }}
                />
              )}
              <Icon
                className={cn(
                  'h-4 w-4 shrink-0 relative',
                  active ? '' : 'text-muted-foreground',
                )}
              />
              <span className="text-xs font-medium truncate relative">{item.label}</span>
            </button>
          )
        })}
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
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
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
          className="h-7 w-7"
          title="Reload"
          onClick={() => dispatch('refresh')}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      )
    case 'knowledge':
      return (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Rebuild Embeddings"
            onClick={() => dispatch('rebuild-embeddings')}
          >
            <Layers className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Rebuild BM25"
            onClick={() => dispatch('rebuild-bm25')}
          >
            <Hash className="h-3.5 w-3.5" />
          </Button>
        </div>
      )
    default:
      return null
  }
}
