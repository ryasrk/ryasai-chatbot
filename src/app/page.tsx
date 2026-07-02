'use client'

import { useCallback, useState, useEffect } from 'react'
import {
  LayoutDashboard,
  MessageSquare,
  Database,
  FileText,
  ShieldCheck,
  Settings,
  Brain,
  Menu,
  X,
  CheckCircle2,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { publicConfig } from '@/lib/public-config'
import { useActiveUser } from '@/hooks/use-active-user'
import { DashboardView } from '@/components/views/dashboard-view'
import { ChatView } from '@/components/views/chat-view'
import { IntegrationsView } from '@/components/views/integrations-view'
import { KnowledgeBaseView } from '@/components/views/knowledge-base-view'
import { SecurityView } from '@/components/views/security-view'
import { SettingsView } from '@/components/views/settings-view'
import { LoginView } from '@/components/views/login-view'
import { SetupView } from '@/components/views/setup-view'
import { Topbar } from '@/components/views/topbar'
import {
  resolveViewFromSearch,
  type ViewKey,
} from '@/lib/view-routing'

const NAV: { key: ViewKey; label: string; icon: typeof Brain; desc: string }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, desc: 'Ringkasan operasional' },
  { key: 'chat', label: 'Chat', icon: MessageSquare, desc: 'Asisten internal' },
  { key: 'integrations', label: 'Data Sources', icon: Database, desc: 'Database dan REST API' },
  { key: 'knowledge', label: 'Knowledge', icon: FileText, desc: 'Dokumen dan RAG' },
  { key: 'security', label: 'Monitoring', icon: ShieldCheck, desc: 'Audit dan guardrails' },
  { key: 'settings', label: 'Settings', icon: Settings, desc: 'Admin dan konfigurasi' },
]

function renderView(view: ViewKey) {
  switch (view) {
    case 'dashboard':
      return <DashboardView />
    case 'chat':
      return <ChatView />
    case 'integrations':
      return <IntegrationsView />
    case 'knowledge':
      return <KnowledgeBaseView />
    case 'security':
      return <SecurityView />
    case 'settings':
      return <SettingsView />
  }
}

export default function Home() {
  const [view, setViewState] = useState<ViewKey>('dashboard')
  const [mobileOpen, setMobileOpen] = useState(false)
  const { user, loading, unauthorized, refresh } = useActiveUser()

  // Setup status — fetched once on mount. When setup is not yet complete the
  // wizard renders (even if unauthorized, because the admin step auto-logs-in).
  const [setup, setSetup] = useState<{
    setupCompleted: boolean
    hasAdmin: boolean
  } | null>(null)

  useEffect(() => {
    fetch('/api/setup/status', { cache: 'no-store' }).then(async (r) =>
      setSetup(r.ok ? await r.json() : { setupCompleted: true, hasAdmin: true }),
    )
  }, [])

  useEffect(() => {
    document.title = 'ryasai'
    queueMicrotask(() => {
      setViewState(resolveViewFromSearch(window.location.search))
    })
  }, [])

  useEffect(() => {
    const onPopState = () => setViewState(resolveViewFromSearch(window.location.search))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const setView = useCallback((nextView: ViewKey) => {
    setViewState(nextView)
    const url = new URL(window.location.href)
    if (nextView === 'dashboard') {
      url.searchParams.delete('view')
    } else {
      url.searchParams.set('view', nextView)
    }
    window.history.pushState(null, '', url)
  }, [])

  // Setup gate — must come BEFORE the auth gate: when setup is not yet complete
  // the wizard renders even without a session (the admin step auto-logs-in).
  if (setup && !setup.setupCompleted) {
    return (
      <SetupView
        hasAdmin={setup.hasAdmin}
        onDone={() => {
          setSetup({ setupCompleted: true, hasAdmin: true })
          refresh()
        }}
      />
    )
  }

  // Auth gate: when there is no valid session, render the login screen instead
  // of the app shell. While the session is still being checked we render the
  // full shell skeleton so a logged-in user doesn't see a flash of the login
  // page.
  if (!loading && unauthorized) {
    return <LoginView onSuccess={refresh} />
  }

  return (
    <>
      <div className="min-h-screen flex flex-col bg-muted/25">
        {/* Top sticky header */}
        <Topbar user={user} loading={loading} onMenuClick={() => setMobileOpen((v) => !v)} />

        <div className="flex flex-1 w-full">
          {/* Sidebar — desktop */}
          <aside
            className={cn(
              'hidden md:flex md:w-64 lg:w-72 shrink-0 flex-col border-r bg-background',
              'sticky top-[57px] h-[calc(100vh-57px)]',
            )}
          >
            <SidebarContent view={view} setView={setView} scope="desktop" />
          </aside>

          {/* Sidebar — mobile drawer */}
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
                  transition={{ type: 'spring', stiffness: 360, damping: 36 }}
                >
                  <div className="flex items-center justify-between p-4 border-b">
                    <span className="font-semibold">Navigasi</span>
                    <button
                      onClick={() => setMobileOpen(false)}
                      className="p-1.5 rounded-md hover:bg-muted"
                      aria-label="Tutup menu"
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
                    scope="mobile"
                  />
                </motion.aside>
              </div>
            )}
          </AnimatePresence>

          {/* Main content */}
          <main className="flex-1 min-w-0 flex flex-col">
            <div className="flex-1 p-4 md:p-6">
              <ViewHeader view={view} />
              <div className="mt-5">
                {renderView(view)}
              </div>
            </div>
            <Footer />
          </main>
        </div>
      </div>
    </>
  )
}

function SidebarContent({
  view,
  setView,
  scope,
}: {
  view: ViewKey
  setView: (v: ViewKey) => void
  scope: 'desktop' | 'mobile'
}) {
  return (
    <div className="flex flex-col h-full">
      <nav
        className="flex-1 p-3 space-y-1 overflow-y-auto"
      >
        {NAV.map((item) => {
          const Icon = item.icon
          const active = view === item.key
          return (
            <button
              key={item.key}
              onClick={() => setView(item.key)}
              className={cn(
                'relative w-full flex items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
                active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-foreground',
              )}
            >
              <Icon
                className={cn(
                  'h-5 w-5 mt-0.5 shrink-0',
                  active ? '' : 'text-muted-foreground',
                )}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium leading-tight">{item.label}</div>
                <div
                  className={cn(
                    'text-xs leading-tight mt-0.5 truncate',
                    active ? 'text-primary-foreground/80' : 'text-muted-foreground',
                  )}
                >
                  {item.desc}
                </div>
              </div>
            </button>
          )
        })}
      </nav>
      <div className="p-3 border-t">
        <div
          className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground space-y-2"
        >
          <div className="flex items-center gap-2 font-medium text-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            Sistem Aktif
          </div>
          <div>v{publicConfig.appVersion} · Dedicated Admin</div>
          <div>API-only LLM · Guardrails AST</div>
          <div>RAG · SQL · REST API Router</div>
        </div>
      </div>
    </div>
  )
}

function ViewHeader({ view }: { view: ViewKey }) {
  const item = NAV.find((n) => n.key === view)
  if (!item) return null
  const Icon = item.icon
  return (
    <div
      className="flex items-center justify-between gap-4 border-b pb-4"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center justify-center h-9 w-9 rounded-md border bg-background text-muted-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{item.label}</h1>
          <p className="text-sm text-muted-foreground">{item.desc}</p>
        </div>
      </div>
    </div>
  )
}

function Footer() {
  return (
    <footer className="mt-auto border-t bg-background">
      <div className="px-4 md:px-6 py-3 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Brain className="h-3.5 w-3.5" />
          <span>ryasai · Dedicated Company Chatbot</span>
        </div>
        <div className="flex items-center gap-3">
          <span>v{publicConfig.appVersion}</span>
          <span aria-hidden>·</span>
          <span>Production Core</span>
        </div>
      </div>
    </footer>
  )
}
