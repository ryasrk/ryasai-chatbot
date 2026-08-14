'use client'

import { useState } from 'react'
import { Globe, Zap, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import type { McpTestState } from './types'
import { McpTestResultBlock } from './mcp-server-dialog'

interface QuickConnectProps {
  onConnected: () => void
}

export function McpQuickConnect({ onConnected }: QuickConnectProps) {
  const [quickUrl, setQuickUrl] = useState('')
  const [quickConnecting, setQuickConnecting] = useState(false)
  const [quickResult, setQuickResult] = useState<McpTestState | null>(null)

  async function handleQuickConnect() {
    const raw = quickUrl.trim()
    if (!raw) {
      toast.error('Paste an MCP URL first.')
      return
    }
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      toast.error('Invalid URL.')
      return
    }
    const transport = raw.toLowerCase().includes('/sse') && !raw.toLowerCase().includes('/mcp') ? 'sse' : 'http'
    setQuickConnecting(true)
    setQuickResult({ status: 'testing' })
    try {
      const res = await fetch('/api/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: parsed.hostname,
          description: 'Quick-added via URL',
          transport,
          command: '',
          args: [],
          url: raw,
          envVars: {},
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        setQuickResult({ status: 'error', error: data.error || 'Failed to create server.' })
        return
      }
      onConnected()
      const id = data.server?.id
      if (!id) {
        setQuickResult(null)
        return
      }
      const testRes = await fetch(`/api/mcp/servers/${id}/test`, { method: 'POST' })
      const testData = await testRes.json()
      if (testData.ok) {
        setQuickResult({ status: 'success', tools: testData.tools ?? [] })
        setQuickUrl('')
      } else {
        setQuickResult({ status: 'error', error: testData.error || 'Connection test failed.' })
      }
    } catch (e) {
      setQuickResult({
        status: 'error',
        error: e instanceof Error ? e.message : 'Connection failed.',
      })
    } finally {
      setQuickConnecting(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-md border border-border/60 p-2">
        <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <Input
          value={quickUrl}
          onChange={(e) => setQuickUrl(e.target.value)}
          placeholder="Paste MCP URL (…/sse or …/mcp) for quick connect"
          className="h-7 text-xs flex-1 border-0 shadow-none focus-visible:ring-0"
          onKeyDown={(e) => { if (e.key === 'Enter' && !quickConnecting) handleQuickConnect() }}
        />
        <Button
          size="sm"
          icon={quickConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          onClick={handleQuickConnect}
          disabled={quickConnecting || !quickUrl.trim()}
          className="h-7 text-xs shrink-0"
        >
          Connect
        </Button>
      </div>
      {quickResult && <McpTestResultBlock result={quickResult} />}
    </div>
  )
}
