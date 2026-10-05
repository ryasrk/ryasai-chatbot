'use client'

import { type ReactNode } from 'react'
import {
  LayoutDashboard,
  MessageSquare,
  Database,
  FileText,
  ShieldCheck,
  Settings,
  Brain,
  Wrench,
  Bot,
  Puzzle,
  Clock,
  Plug,
  RefreshCw,
  Layers,
  Hash,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { type ViewKey } from '@/lib/view-routing'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export interface NavItem {
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
export const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
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
export const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

export interface SidebarContentProps {
  view: ViewKey
  setView: (v: ViewKey) => void
  role?: string
  collapsed?: boolean
}

export function SidebarContent({
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
                'relative w-full flex items-center justify-center rounded-md px-2.5 py-1.5 text-left transition-colors group',
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
               * COMPACT BY MEASUREMENT, not by taste, and the measurement was taken in a browser at the reported width.
               * The user runs the app at a browser zoom that leaves ~584-626 CSS px of viewport height, and reported
               * "Settings" invisible. MEASURED with Playwright logged in as a real admin: the nav content was 564px tall
               * against 479-521px of space, so the LAST entry sat below the fold with the nav merely scrollable — the
               * 1094ac6 fix made the overflow reachable without removing it. py-2.5 made every row 40px; py-2 reclaims
               * 48px across the twelve rows but the sweep still overflowed at 584px, which is why this is py-1.5: a 32px
               * row (h-5 icon + 12px padding). The icon and label stay h-5/text-sm, so nothing becomes harder to read or
               * click; the row is full-width, which is what makes 32px comfortable for a pointer.
               */
              'relative w-full flex items-center gap-3 rounded-md px-3 py-1.5 text-left transition-colors',
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
      <nav className="flex-1 min-h-0 px-2 py-1 overflow-y-auto">
        <div className="flex flex-col [@media(min-height:640px)]:min-h-full [@media(min-height:640px)]:justify-between">
          <div className="space-y-1">
            {groups.slice(0, -1).map((group, gi) => (
              <div key={group.title} className={gi > 0 ? 'mt-0.5' : undefined}>
                {collapsed ? (
                  // Collapsed: a hairline separator. A text header cannot fit in 72px, and dropping the
                  // grouping entirely would make collapsing the sidebar also collapse the information
                  // architecture — the grouping is the point, not decoration.
                  gi > 0 && <div className="mx-2 mb-1.5 border-t border-border/60" />
                ) : (
                  // pt-0.5 instead of pt-1: with FOUR groups this is 8px, and it is spacing no one reads as structure.
                  <div className="px-3 pb-0.5 pt-1 text-[10px] leading-none font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {group.title}
                  </div>
                )}
                <div className="space-y-px">{group.items.map(renderItem)}</div>
              </div>
            ))}
          </div>

          {groups.length > 0 && (
            <div className="[@media(min-height:640px)]:mt-auto [@media(min-height:640px)]:pt-1">
              {groups.slice(-1).map((group) => (
                <div key={group.title}>
                  {collapsed ? (
                    <div className="mx-2 mb-1.5 border-t border-border/60" />
                  ) : (
                    <div className="px-3 pb-0.5 pt-1 text-[10px] leading-none font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {group.title}
                    </div>
                  )}
                  <div className="space-y-px">{group.items.map(renderItem)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </nav>
    </div>
  )
}

export function ViewHeader({ view, action }: { view: ViewKey; action?: ReactNode }) {
  const item = NAV.find((n) => n.key === view)
  if (!item) return null
  const Icon = item.icon
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-base sm:text-lg font-semibold tracking-tight text-foreground">{item.label}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function renderHeaderAction(view: ViewKey): ReactNode {
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
