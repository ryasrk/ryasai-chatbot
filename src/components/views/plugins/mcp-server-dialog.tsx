'use client'

import { useEffect, useState } from 'react'
import {
  Check,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import type { McpServerRow, McpTestState } from './types'

const EMPTY_MCP_FORM = {
  name: '',
  description: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  envVars: '',
  headers: '',
}

interface DialogProps {
  open: boolean
  editing: McpServerRow | null
  onClose: () => void
  onSaved: () => void
}

export function McpServerDialog({ open, editing, onClose, onSaved }: DialogProps) {
  const [form, setForm] = useState({ ...EMPTY_MCP_FORM })
  const [saving, setSaving] = useState(false)
  const [mcpTestResult, setMcpTestResult] = useState<McpTestState | null>(null)

  useEffect(() => {
    if (!open) return
    if (editing) {
      let argsStr = ''
      try {
        const parsed = JSON.parse(editing.args)
        argsStr = Array.isArray(parsed) ? parsed.join('\n') : ''
      } catch { argsStr = '' }
      setForm({
        name: editing.name,
        description: editing.description,
        transport: editing.transport,
        command: editing.command,
        args: argsStr,
        url: editing.url,
        envVars: '',
        headers: '',
      })
    } else {
      setForm({ ...EMPTY_MCP_FORM })
    }
    setMcpTestResult(null)
  }, [open, editing])

  async function handleSave() {
    if (!form.name.trim()) {
      toast.error('Name is required.')
      return
    }
    if (form.transport === 'stdio' && !form.command.trim()) {
      toast.error('Command is required for stdio transport.')
      return
    }
    if (form.transport !== 'stdio' && !form.url.trim()) {
      toast.error('URL is required for sse/http transport.')
      return
    }

    setSaving(true)
    setMcpTestResult({ status: 'testing' })
    try {
      const argsArr = form.args.split('\n').map((a) => a.trim()).filter(Boolean)
      const envVars: Record<string, string> = {}
      if (form.envVars.trim()) {
        for (const line of form.envVars.split('\n')) {
          const idx = line.indexOf('=')
          if (idx > 0) {
            envVars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
          }
        }
      }

      const headers: Record<string, string> = {}
      if (form.headers.trim()) {
        for (const line of form.headers.split('\n')) {
          const idx = line.indexOf(':')
          if (idx > 0) {
            headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
          }
        }
      }

      const isEdit = editing !== null
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim(),
        transport: form.transport,
        command: form.command.trim(),
        args: argsArr,
        url: form.url.trim(),
      }

      // ponytail: only send envVars/headers when non-empty OR creating new.
      // On edit with blank fields, omit the key so the server preserves existing secrets.
      if (Object.keys(envVars).length > 0 || !isEdit) {
        body.envVars = envVars
      }
      if (Object.keys(headers).length > 0 || !isEdit) {
        body.headers = headers
      }

      const url = isEdit ? `/api/mcp/servers/${editing!.id}` : '/api/mcp/servers'
      const method = isEdit ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!data.ok) {
        toast.error(data.error || 'Failed to save MCP server.')
        setMcpTestResult(null)
        return
      }

      toast.success(isEdit ? 'MCP server updated.' : 'MCP server added.')
      onSaved()

      const createdId = isEdit ? editing!.id : data.server?.id
      if (!createdId) {
        setMcpTestResult(null)
        onClose()
        return
      }
      try {
        const testRes = await fetch(`/api/mcp/servers/${createdId}/test`, { method: 'POST' })
        const testData = await testRes.json()
        if (testData.ok) {
          setMcpTestResult({ status: 'success', tools: testData.tools ?? [] })
        } else {
          setMcpTestResult({ status: 'error', error: testData.error || 'Connection test failed.' })
        }
      } catch (e) {
        setMcpTestResult({
          status: 'error',
          error: e instanceof Error ? e.message : 'Connection test failed.',
        })
      }
    } catch {
      toast.error('Failed to save MCP server.')
      setMcpTestResult(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {editing ? 'Edit MCP Server' : 'Add MCP Server'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {editing ? 'Update MCP server configuration.' : 'Connect a new MCP server (stdio, sse, or http).'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Filesystem"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Read/write files on the local filesystem"
              className="h-8 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Transport</Label>
              <Select value={form.transport} onValueChange={(v) => setForm({ ...form, transport: v })}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio" className="text-xs">stdio</SelectItem>
                  <SelectItem value="sse" className="text-xs">sse</SelectItem>
                  <SelectItem value="http" className="text-xs">http</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.transport === 'stdio' ? (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Command</Label>
                <Input
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder="npx"
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Args (one per line)</Label>
                <Textarea
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'}
                  className="text-xs font-mono min-h-[64px]"
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs">URL</Label>
              <Input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://mcp-server.example.com/sse"
                className="h-8 text-xs font-mono"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">Env Vars (KEY=value, one per line)</Label>
            <Textarea
              value={form.envVars}
              onChange={(e) => setForm({ ...form, envVars: e.target.value })}
              placeholder={'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx\nBRAVE_API_KEY=BSAxxx'}
              className="text-xs font-mono min-h-[56px]"
            />
            <p className="text-xs text-muted-foreground">
              {editing?.hasEnvVars ? 'Leave blank to keep existing env vars.' : 'Encrypted at rest (AES-256-GCM).'}
            </p>
          </div>
          {form.transport !== 'stdio' && (
            <div className="space-y-1.5">
              <Label className="text-xs">HTTP Headers (Header: value, one per line)</Label>
              <Textarea
                value={form.headers}
                onChange={(e) => setForm({ ...form, headers: e.target.value })}
                placeholder={'Authorization: Bearer token\nX-API-Key: key123'}
                className="text-xs font-mono min-h-[56px]"
              />
              <p className="text-xs text-muted-foreground">
                {editing?.hasHeaders ? 'Leave blank to keep existing headers.' : 'Encrypted at rest (AES-256-GCM).'}
              </p>
            </div>
          )}
        </div>

        {mcpTestResult && (
          <McpTestResultBlock result={mcpTestResult} />
        )}

        <DialogFooter className="flex !justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { onClose(); setMcpTestResult(null) }}
            disabled={saving}
            className="h-7 text-xs"
          >
            {mcpTestResult ? 'Close' : 'Cancel'}
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
            className="h-7 text-xs gap-1.5"
            icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          >
            {mcpTestResult?.status === 'error' ? 'Retry' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function McpTestResultBlock({ result }: { result: McpTestState }) {
  if (result.status === 'testing') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 p-2.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Installing and detecting tools...</span>
      </div>
    )
  }
  if (result.status === 'error') {
    return (
      <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
          <span className="text-xs font-medium text-destructive">Connection failed</span>
        </div>
        <p className="text-xs text-destructive">{result.error}</p>
        <p className="text-xs text-muted-foreground">Edit the config to fix, then click Retry.</p>
      </div>
    )
  }
  const tools = result.tools ?? []
  return (
    <div className="space-y-1.5 rounded-md border border-success/30 bg-success/5 p-2.5">
      <div className="flex items-center gap-2">
        <Check className="h-3.5 w-3.5 text-success" />
        <span className="text-xs font-medium text-success">
          Connected! Found {tools.length} tool{tools.length === 1 ? '' : 's'}:
        </span>
      </div>
      {tools.length > 0 && (
        <ul className="space-y-1 max-h-[140px] overflow-auto [scrollbar-width:thin]">
          {tools.map((t) => (
            <li key={t.name} className="text-xs">
              <code className="font-mono text-foreground">{t.name}</code>
              {t.description && <span className="text-muted-foreground"> — {t.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
