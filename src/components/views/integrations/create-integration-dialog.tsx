'use client'

import { useMemo, useState } from 'react'
import { Loader2, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { extractError } from '@/lib/extract-error'
import { DB_PROVIDER_PRESETS, getDbProviderPreset } from '@/lib/db-provider-presets'
import { CreateFormState, EMPTY_FORM } from './types'

/**
 * Parse a postgresql:// or mysql:// URL client-side to prefill the form.
 * Mirrors server-side parseConnectionString — kept deliberately small; the
 * server re-parses and is authoritative.
 */
function parseConnString(raw: string): Partial<CreateFormState> | null {
  const s = raw.trim()
  if (!/^(postgres(ql)?|mysql(2)?):\/\//i.test(s)) return null
  try {
    const u = new URL(s)
    return {
      host: u.hostname,
      port: u.port || '',
      username: u.username ? decodeURIComponent(u.username) : '',
      password: u.password ? decodeURIComponent(u.password) : '',
      database_name: decodeURIComponent(u.pathname.replace(/^\//, '')),
    }
  } catch {
    return null
  }
}

export function CreateIntegrationDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: () => void
}) {
  const [form, setForm] = useState<CreateFormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [connString, setConnString] = useState('')

  const preset = getDbProviderPreset(form.provider)
  const isPostgresFamily = preset?.family === 'POSTGRESQL'
  const isMysqlFamily = preset?.family === 'MYSQL'

  const update = (k: keyof CreateFormState, v: string) =>
    setForm((f) => ({ ...f, [k]: v }))

  const handleProviderChange = (providerId: string) => {
    const p = getDbProviderPreset(providerId)
    setForm((f) => ({
      ...f,
      provider: providerId,
      port: p && p.defaultPort > 0 ? String(p.defaultPort) : f.port,
    }))
  }

  const handleApplyConnString = () => {
    const parsed = parseConnString(connString)
    if (!parsed) {
      toast.error('Not a valid postgresql:// or mysql:// connection string.')
      return
    }
    setForm((f) => ({
      ...f,
      host: parsed.host ?? f.host,
      port: parsed.port ?? f.port,
      username: parsed.username ?? f.username,
      password: parsed.password ?? f.password,
      database_name: parsed.database_name ?? f.database_name,
    }))
    toast.success('Connection string applied — review the fields before saving.')
  }

  const validate = (): boolean => {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = 'Name is required.'
    if (!form.provider) e.provider = 'Provider is required.'
    if (!form.host.trim()) e.host = 'Host is required.'
    if (!form.database_name.trim()) e.database_name = 'Database is required.'
    if (!form.username.trim()) e.username = 'Username is required.'
    if (!form.password) e.password = 'Password is required.'
    if (form.port && !/^\d+$/.test(form.port)) e.port = 'Port must be a number.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return
    setSubmitting(true)
    try {
      const config: Record<string, unknown> = {
        host: form.host.trim(),
          port: Number(form.port) || 0,
          username: form.username.trim(),
          password: form.password,
          database_name: form.database_name.trim(),
        }

      const res = await fetch('/api/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          type: 'DATABASE',
          provider: form.provider,
          config,
        }),
      })
      const json = await res.json()
      if (res.ok && json.ok) {
        toast.success('Integration created successfully & schema indexed.')
        setForm(EMPTY_FORM)
        setConnString('')
        setErrors({})
        onCreated()
      } else {
        toast.error(extractError(json.error, 'Failed to create integration.'), {
          duration: 10000,
        })
      }
    } catch (e) {
      toast.error('Network error while creating integration.')
      console.error(e)
    } finally {
      setSubmitting(false)
    }
  }

  const defaultPort = useMemo(
    () => (preset && preset.defaultPort > 0 ? String(preset.defaultPort) : '5432'),
    [preset],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!submitting) {
          onOpenChange(o)
          if (!o) {
            setForm(EMPTY_FORM)
            setErrors({})
          }
        }
      }}
    >
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Database</DialogTitle>
          <DialogDescription>
            Register a SQL database connection. The system will encrypt credentials,
            test the connection, and reflect the schema automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="int-name">
              Integration Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="int-name"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="e.g. ERP Production"
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="int-provider">Database Provider</Label>
            <Select
              value={form.provider}
              onValueChange={handleProviderChange}
            >
              <SelectTrigger id="int-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DB_PROVIDER_PRESETS.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.provider && (
            <p className="text-xs text-muted-foreground bg-muted/60 border rounded-md px-3 py-2">
              {preset?.hint ?? 'Provider'}
              {preset?.sslByDefault && (
                <span className="block mt-1 text-warning">
                  SSL is recommended for this provider.
                </span>
              )}
            </p>
          )}

          {/* Connection string quick-fill — managed providers hand users a URL */}
          {(isPostgresFamily || isMysqlFamily) && (
            <div className="space-y-1.5">
              <Label htmlFor="int-connstring" className="flex items-center gap-1.5">
                <Link2 className="h-3.5 w-3.5" />
                Connection string (optional)
              </Label>
              <div className="flex gap-2">
                <Input
                  id="int-connstring"
                  value={connString}
                  onChange={(e) => setConnString(e.target.value)}
                  placeholder={
                    isMysqlFamily
                      ? 'mysql://user:pass@host:3306/db'
                      : 'postgresql://user:pass@host:5432/db'
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleApplyConnString}
                  disabled={!connString.trim()}
                  className="shrink-0"
                >
                  Apply
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Paste the provider's connection string to auto-fill the fields below. Fields stay editable.
              </p>
            </div>
          )}

          {/* Config fields — connection string providers */}
          <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="int-host">Host</Label>
                  <Input
                    id="int-host"
                    value={form.host}
                    onChange={(e) => update('host', e.target.value)}
                    placeholder="localhost"
                  />
                  {errors.host && (
                    <p className="text-xs text-destructive">{errors.host}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="int-port">Port</Label>
                  <Input
                    id="int-port"
                    inputMode="numeric"
                    value={form.port}
                    onChange={(e) => update('port', e.target.value)}
                    placeholder={defaultPort}
                  />
                  {errors.port && (
                    <p className="text-xs text-destructive">{errors.port}</p>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="int-db">Database Name</Label>
                <Input
                  id="int-db"
                  value={form.database_name}
                  onChange={(e) => update('database_name', e.target.value)}
                  placeholder="erp_db"
                />
                {errors.database_name && (
                  <p className="text-xs text-destructive">{errors.database_name}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="int-user">Username</Label>
                  <Input
                    id="int-user"
                    value={form.username}
                    onChange={(e) => update('username', e.target.value)}
                    placeholder="db_user"
                  />
                  {errors.username && (
                    <p className="text-xs text-destructive">{errors.username}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="int-pass">Password</Label>
                  <Input
                    id="int-pass"
                    type="password"
                    value={form.password}
                    onChange={(e) => update('password', e.target.value)}
                    placeholder="••••••••"
                  />
                  {errors.password && (
                    <p className="text-xs text-destructive">{errors.password}</p>
                  )}
                </div>
              </div>
            </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            icon={submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Creating & testing…' : 'Create & Test Connection'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
