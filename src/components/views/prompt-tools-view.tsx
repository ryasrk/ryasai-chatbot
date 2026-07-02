'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Wrench,
  Database,
  Server,
  Save,
  Loader2,
  ShieldCheck,
  ExternalLink,
  FileText,
} from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

interface PromptSettings {
  systemPrompt: string
  tools: { rag: boolean; sql: boolean; restApi: boolean }
}

interface RestConnector {
  id: string
  name: string
  baseUrl: string
  isActive: boolean
  _count?: { endpoints?: number }
}

const DEFAULT_SETTINGS: PromptSettings = {
  systemPrompt: '',
  tools: { rag: true, sql: true, restApi: true },
}

const TOOL_ROWS: {
  key: keyof PromptSettings['tools']
  label: string
  desc: string
}[] = [
  { key: 'rag', label: 'Knowledge / RAG', desc: 'Cari jawaban dari dokumen yang telah diunggah.' },
  { key: 'sql', label: 'SQL (read-only)', desc: 'Query database terhubung dengan read-only guardrail.' },
  { key: 'restApi', label: 'REST API', desc: 'Panggil endpoint REST yang di-whitelist.' },
]

/**
 * Prompt & Tools view — system prompt override and tool routing toggles,
 * plus a read-only summary of the SQL guardrail and REST endpoint whitelist.
 */
export function PromptToolsView() {
  const [settings, setSettings] = useState<PromptSettings>(DEFAULT_SETTINGS)
  const [connectors, setConnectors] = useState<RestConnector[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    try {
      const [settingsRes, connectorsRes] = await Promise.all([
        fetch('/api/prompt-tools', { cache: 'no-store' }),
        fetch('/api/data-sources/rest-connectors', { cache: 'no-store' }),
      ])
      if (settingsRes.ok) {
        const data = await settingsRes.json()
        if (data?.ok && data.settings) {
          setSettings(data.settings as PromptSettings)
        }
      }
      if (connectorsRes.ok) {
        const data = await connectorsRes.json()
        if (data?.ok && Array.isArray(data.items)) {
          setConnectors(data.items as RestConnector[])
        }
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function updateTool(key: keyof PromptSettings['tools'], value: boolean) {
    setSettings((prev) => ({ ...prev, tools: { ...prev.tools, [key]: value } }))
    setDirty(true)
  }

  function updatePrompt(value: string) {
    setSettings((prev) => ({ ...prev, systemPrompt: value }))
    setDirty(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/prompt-tools', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? 'Gagal menyimpan.')
      }
      if (json.settings) setSettings(json.settings as PromptSettings)
      setDirty(false)
      toast.success('Pengaturan prompt & tools tersimpan')
    } catch (e) {
      toast.error('Gagal menyimpan pengaturan', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  const totalEndpoints = connectors.reduce((sum, c) => sum + (c._count?.endpoints ?? 0), 0)

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Card 1: System Prompt & Tools */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            System Prompt &amp; Tools
          </CardTitle>
          <CardDescription>
            Atur instruksi sistem default dan aktifkan/nonaktifkan tool yang dipakai router.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="system-prompt">System Prompt</Label>
            <Textarea
              id="system-prompt"
              placeholder="Contoh: Jawab selalu dalam Bahasa Indonesia, ringkas, dan sitasi sumber."
              value={settings.systemPrompt}
              onChange={(e) => updatePrompt(e.target.value)}
              rows={4}
              className="resize-y"
            />
            <p className="text-[11px] text-muted-foreground">
              Dikirim sebagai system message sebelum pertanyaan pengguna. Kosongkan untuk memakai default bawaan model.
            </p>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <div className="text-sm font-medium">Tool Routing</div>
            <div className="divide-y">
              {TOOL_ROWS.map((row) => (
                <div key={row.key} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                  <div className="pr-4">
                    <div className="text-sm font-medium">{row.label}</div>
                    <div className="text-[11px] text-muted-foreground">{row.desc}</div>
                  </div>
                  <Switch
                    checked={settings.tools[row.key]}
                    onCheckedChange={(v) => updateTool(row.key, v)}
                    aria-label={row.label}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={!dirty || saving} className="gap-1.5">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Simpan
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Card 2: Guardrails & Whitelist */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Guardrails &amp; Whitelist
          </CardTitle>
          <CardDescription>
            Ringkasan aturan keamanan yang membatasi tool. Pengaturan ini hanya-baca — kelola di Data Sources.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* SQL guardrail rules */}
          <div className="space-y-2">
            <div className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              SQL Guardrail
            </div>
            <ul className="space-y-1.5 text-[13px] text-muted-foreground">
              <li className="flex items-start gap-2">
                <ShieldCheck className="h-3.5 w-3.5 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                Hanya perintah <code className="rounded bg-muted px-1 font-mono text-[11px]">SELECT</code> yang diizinkan.
              </li>
              <li className="flex items-start gap-2">
                <ShieldCheck className="h-3.5 w-3.5 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                DML/DDL (<code className="rounded bg-muted px-1 font-mono text-[11px]">INSERT</code>,{' '}
                <code className="rounded bg-muted px-1 font-mono text-[11px]">UPDATE</code>,{' '}
                <code className="rounded bg-muted px-1 font-mono text-[11px]">DELETE</code>, dll.) diblokir.
              </li>
              <li className="flex items-start gap-2">
                <ShieldCheck className="h-3.5 w-3.5 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                Koneksi database hanya mengakses skema/ tabel yang di-whitelist.
              </li>
            </ul>
          </div>

          {/* REST endpoint whitelist */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                REST Endpoint Whitelist
              </div>
              <a
                href="?view=integrations"
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                Kelola <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            {connectors.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-[12px] text-muted-foreground">
                <FileText className="h-4 w-4" />
                Belum ada REST connector. Tambahkan dari Data Sources.
              </div>
            ) : (
              <div className="space-y-1.5">
                {connectors.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded-md border bg-background px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{c.name}</div>
                      <div className="text-[11px] text-muted-foreground font-mono truncate">{c.baseUrl}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="text-[10px]">
                        {c._count?.endpoints ?? 0} endpoint
                      </Badge>
                      {c.isActive ? (
                        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 text-[10px]">
                          Aktif
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          Nonaktif
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {totalEndpoints > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Total {totalEndpoints} endpoint terdaftar di whitelist.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Fail-safe routing</AlertTitle>
        <AlertDescription>
          Ketika sebuah tool dinonaktifkan di atas, router otomatis beralih ke mode chat murni
          untuk pertanyaan tersebut — tidak ada tool yang dijalankan tanpa izin eksplisit.
        </AlertDescription>
      </Alert>
    </div>
  )
}
