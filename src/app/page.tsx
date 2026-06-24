'use client'

import { useState, useEffect } from 'react'
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
  CircleDot,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useActiveUser } from '@/hooks/use-active-user'
import { DashboardView } from '@/components/views/dashboard-view'
import { ChatView } from '@/components/views/chat-view'
import { IntegrationsView } from '@/components/views/integrations-view'
import { KnowledgeBaseView } from '@/components/views/knowledge-base-view'
import { SecurityView } from '@/components/views/security-view'
import { SettingsView } from '@/components/views/settings-view'
import { Topbar } from '@/components/views/topbar'

type ViewKey =
  | 'dashboard'
  | 'chat'
  | 'integrations'
  | 'knowledge'
  | 'security'
  | 'settings'

const NAV: { key: ViewKey; label: string; icon: typeof Brain; desc: string }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, desc: 'Ringkasan & analitik' },
  { key: 'chat', label: 'AI Chat', icon: MessageSquare, desc: 'Asisten AI streaming' },
  { key: 'integrations', label: 'Integrasi Data', icon: Database, desc: 'Dynamic Connector Factory' },
  { key: 'knowledge', label: 'Knowledge Base', icon: FileText, desc: 'Dokumen & RAG' },
  { key: 'security', label: 'Keamanan & Audit', icon: ShieldCheck, desc: 'Guardrails & log' },
  { key: 'settings', label: 'Pengaturan', icon: Settings, desc: 'User & sistem' },
]

export default function Home() {
  const [view, setView] = useState<ViewKey>('dashboard')
  const [mobileOpen, setMobileOpen] = useState(false)
  const { user, loading } = useActiveUser()

  // keep document title synced
  useEffect(() => {
    document.title = 'Enterprise AI Internal Assistant'
  }, [])

  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
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
          <SidebarContent view={view} setView={setView} />
        </aside>

        {/* Sidebar — mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setMobileOpen(false)}
            />
            <aside className="absolute left-0 top-0 h-full w-72 bg-background border-r shadow-xl flex flex-col">
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
              />
            </aside>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 p-4 md:p-6 lg:p-8">
            <ViewHeader view={view} />
            <div className="mt-4 md:mt-6">
              {view === 'dashboard' && <DashboardView />}
              {view === 'chat' && <ChatView />}
              {view === 'integrations' && <IntegrationsView />}
              {view === 'knowledge' && <KnowledgeBaseView />}
              {view === 'security' && <SecurityView />}
              {view === 'settings' && <SettingsView />}
            </div>
          </div>
          <Footer />
        </main>
      </div>
    </div>
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
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {NAV.map((item) => {
          const Icon = item.icon
          const active = view === item.key
          return (
            <button
              key={item.key}
              onClick={() => setView(item.key)}
              className={cn(
                'w-full flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'hover:bg-muted text-foreground',
              )}
            >
              <Icon className={cn('h-5 w-5 mt-0.5 shrink-0', active ? '' : 'text-muted-foreground')} />
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
        <div className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground space-y-2">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <CircleDot className="h-3.5 w-3.5 text-emerald-500" />
            Sistem Aktif
          </div>
          <div>v2.0.0 · Multi-tenant</div>
          <div>AES-256-GCM · Guardrails AST</div>
          <div>RAG Pipeline · WebSocket Streaming</div>
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
    <div className="flex items-center gap-3">
      <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">{item.label}</h1>
        <p className="text-sm text-muted-foreground">{item.desc}</p>
      </div>
    </div>
  )
}

function Footer() {
  return (
    <footer className="mt-auto border-t bg-background/60 backdrop-blur">
      <div className="px-4 md:px-6 lg:px-8 py-3 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Brain className="h-3.5 w-3.5" />
          <span>Enterprise AI Internal Assistant · Internal Engineering Only</span>
        </div>
        <div className="flex items-center gap-3">
          <span>Spesifikasi Teknis v2.0.0</span>
          <span aria-hidden>·</span>
          <span>Multi-Source Knowledge & Query Engine</span>
        </div>
      </div>
    </footer>
  )
}
