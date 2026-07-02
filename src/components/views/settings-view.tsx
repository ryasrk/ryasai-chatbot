'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Building2,
  User as UserIcon,
  ShieldCheck,
  Server,
  KeyRound,
  Database,
  Lock,
  ScrollText,
  Cpu,
  Boxes,
  GitBranch,
  Terminal,
  Bot,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Save,
  Plug,
  CheckCircle2,
  Copy,
  Trash2,
  Plus,
} from 'lucide-react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { id as localeId } from 'date-fns/locale'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
import type { ActiveUser, PublicLlmConfig } from '@/lib/types'

const id = (n: number) => n.toLocaleString('id-ID')

const ROLE_STYLES: Record<string, string> = {
  admin: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  manager: 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  staff: 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
}

const initials = (name: string) =>
  name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

interface ApiKeyRow {
  id: string
  isActive: boolean
  label: string
  maskedKey: string
  requestLimitPerMinute: number | null
  dailyRequestLimit: number | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export function SettingsView() {
  const [tab, setTab] = useState('profile')

  return (
    <Tabs value={tab} onValueChange={setTab} className="w-full">
      <div className="overflow-x-auto -mx-1 px-1 pb-1">
        <TabsList className="w-max">
          <TabsTrigger value="profile" className="gap-1.5">
            <Building2 className="h-3.5 w-3.5" />
            Profil & Perusahaan
          </TabsTrigger>
          <TabsTrigger value="api-keys" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />
            API Keys
          </TabsTrigger>
          <TabsTrigger value="security" className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Keamanan
          </TabsTrigger>
          <TabsTrigger value="llm" className="gap-1.5">
            <Bot className="h-3.5 w-3.5" />
            AI / LLM
          </TabsTrigger>
          <TabsTrigger value="system" className="gap-1.5">
            <Server className="h-3.5 w-3.5" />
            Sistem
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="profile" className="mt-4">
        <ProfileTab />
      </TabsContent>
      <TabsContent value="api-keys" className="mt-4">
        <ApiKeysTab />
      </TabsContent>
      <TabsContent value="security" className="mt-4">
        <SecurityTab />
      </TabsContent>
      <TabsContent value="llm" className="mt-4">
        <LlmTab />
      </TabsContent>
      <TabsContent value="system" className="mt-4">
        <SystemTab />
      </TabsContent>
    </Tabs>
  )
}

// ---------- Tab 1: Profil & Perusahaan ----------
function ProfileTab() {
  const [user, setUser] = useState<ActiveUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/me', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Gagal memuat profil.')
        return r.json()
      })
      .then((d: ActiveUser) => !cancelled && setUser(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Kesalahan.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (error || !user) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center text-sm text-destructive">
          {error ?? 'Data pengguna tidak tersedia.'}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <UserIcon className="h-4 w-4" />
            Pengguna Aktif
          </CardTitle>
          <CardDescription>Identitas yang Anda gunakan saat ini</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <Avatar className="h-14 w-14">
              <AvatarFallback
                className="text-base font-semibold text-white"
                style={{ backgroundColor: 'oklch(0.55 0.18 250)' }}
              >
                {initials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 flex-1">
              <Field label="Nama" value={user.name} />
              <Field label="Email" value={user.email} />
              <div>
                <div className="text-xs text-muted-foreground mb-1">Akses</div>
                <Badge className={cn('capitalize', ROLE_STYLES[user.role])}>Admin tunggal</Badge>
              </div>
              <Field label="Company ID" value={user.companyId} mono />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Perusahaan
          </CardTitle>
          <CardDescription>Instansi yang menggunakan deployment ini</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <Field label="Nama Perusahaan" value={user.companyName ?? '—'} />
            <Field label="Industri" value="—" />
          </div>
        </CardContent>
      </Card>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Mode Dedicated Single Admin</AlertTitle>
        <AlertDescription>
          Produk ini disederhanakan untuk satu admin perusahaan. Tidak ada pengelolaan role
          bertingkat pada UI production; akses admin dipakai untuk setup data source, knowledge,
          API key, dan konfigurasi model.
        </AlertDescription>
      </Alert>
    </div>
  )
}

// ---------- Tab 2: API Keys ----------
function ApiKeysTab() {
  const [items, setItems] = useState<ApiKeyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const load = useCallback(async (showSkeleton = false, signal?: AbortSignal) => {
    if (showSkeleton) setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/api-keys', { cache: 'no-store', signal })
      if (!res.ok) throw new Error('Gagal memuat API keys.')
      const data = (await res.json()) as { items: ApiKeyRow[] }
      if (signal?.aborted) return
      setItems(data.items ?? [])
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'Kesalahan.')
    } finally {
      if (showSkeleton && !signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(true, controller.signal)
    return () => {
      controller.abort()
    }
  }, [load])

  async function handleCreate() {
    const clean = label.trim()
    if (!clean) {
      toast.error('Label API key wajib diisi.')
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/settings/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: clean }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Gagal membuat API key.')
      setNewKey(json.apiKey)
      setLabel('')
      toast.success('API key dibuat. Simpan sekarang, key hanya tampil sekali.')
      await load(false)
    } catch (e) {
      toast.error('Gagal membuat API key', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(id: string) {
    setRevokingId(id)
    try {
      const res = await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok && res.status !== 404) {
        throw new Error(json.error ?? 'Gagal mencabut API key.')
      }
      toast.success(res.status === 404 ? 'API key sudah tidak ada.' : 'API key dicabut.')
      await load(false)
    } catch (e) {
      toast.error('Gagal mencabut API key', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setRevokingId(null)
    }
  }

  async function copyText(text: string, message: string) {
    await navigator.clipboard.writeText(text)
    toast.success(message)
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center text-sm text-destructive">{error}</CardContent>
      </Card>
    )
  }

  const curlExample = `curl -X POST http://localhost:3005/api/v1/chat/completions \\
  -H "Authorization: Bearer ${newKey ?? 'ryas_xxx'}" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Ringkas status invoice overdue bulan ini"}]}'`

  return (
    <div className="space-y-4 md:space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            External API Keys
          </CardTitle>
          <CardDescription>
            Buat Bearer token untuk program lain yang perlu memakai endpoint chat ryasai.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="contoh: ERP backend production"
              className="sm:max-w-sm"
            />
            <Button onClick={handleCreate} disabled={creating || !label.trim()}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Buat API Key
            </Button>
          </div>

          {newKey && (
            <Alert className="border-amber-300 bg-amber-50/70 dark:bg-amber-950/20">
              <KeyRound className="h-4 w-4 text-amber-700 dark:text-amber-300" />
              <AlertTitle>Simpan API key sekarang</AlertTitle>
              <AlertDescription>
                Key hanya ditampilkan sekali.
                <div className="mt-2 flex items-center gap-2 rounded-md bg-background/80 border px-2 py-1.5">
                  <code className="font-mono text-xs break-all flex-1">{newKey}</code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyText(newKey, 'API key disalin.')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Salin
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[180px]">Label</TableHead>
                  <TableHead className="w-[150px]">Key</TableHead>
                  <TableHead className="w-[110px]">Status</TableHead>
                  <TableHead className="w-[150px]">Last Used</TableHead>
                  <TableHead className="w-[130px]">Dibuat</TableHead>
                  <TableHead className="w-[90px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                      Belum ada API key.
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-medium text-sm">{item.label}</div>
                        <div className="text-[11px] text-muted-foreground">
                          Limit: {item.requestLimitPerMinute ?? '∞'}/menit · {item.dailyRequestLimit ?? '∞'}/hari
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{item.maskedKey}</TableCell>
                      <TableCell>
                        {item.isActive && !item.revokedAt ? (
                          <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                            Aktif
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Revoked</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.lastUsedAt ? format(new Date(item.lastUsedAt), 'dd MMM HH:mm', { locale: localeId }) : 'Belum dipakai'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(item.createdAt), 'dd MMM yyyy', { locale: localeId })}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!item.isActive || !!item.revokedAt || revokingId === item.id}
                          onClick={() => handleRevoke(item.id)}
                          className="text-rose-600 hover:text-rose-700"
                        >
                          {revokingId === item.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            Contoh Integrasi Chat API
          </CardTitle>
          <CardDescription>
            Gunakan format OpenAI-style non-streaming untuk integrasi program lain.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted/60 rounded-md p-3 text-[11px] font-mono overflow-x-auto">
            <code>{curlExample}</code>
          </pre>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => copyText(curlExample, 'Contoh curl disalin.')}
          >
            <Copy className="h-3.5 w-3.5" />
            Salin curl
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------- Tab 3: Keamanan ----------
function SecurityTab() {
  return (
    <div className="space-y-4 md:space-y-6">
      <Alert>
        <Lock className="h-4 w-4" />
        <AlertTitle>Arsitektur Keamanan Production</AlertTitle>
        <AlertDescription>
          Empat lapisan keamanan utama melindungi data perusahaan: enkripsi kredensial, validasi
          SQL berbasis AST, scope perusahaan, serta audit logging menyeluruh.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-chart-1" />
              AES-256-GCM Enkripsi Kredensial
            </CardTitle>
            <CardDescription>
              Config integrasi (host, password, API key) disimpan sebagai blob hex terenkripsi di DB.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <pre className="bg-muted/60 rounded-md p-3 text-[11px] font-mono overflow-x-auto">
              <code>{`// Alur enkripsi (src/lib/crypto.ts)
const key = Buffer.from(MASTER_KEY_HEX, 'hex')   // 32 bytes
const nonce = crypto.randomBytes(12)              // GCM 96-bit
const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
const enc = Buffer.concat([
  cipher.update(JSON.stringify(config), 'utf8'),
  cipher.final(),
])
const tag = cipher.getAuthTag()
// Disimpan: hex(nonce) + hex(tag) + hex(enc)
const blob = nonce.toString('hex') + tag.toString('hex') + enc.toString('hex')`}</code>
            </pre>
            <div className="text-xs text-muted-foreground">Contoh blob tersimpan (dimask):</div>
            <code className="block text-[11px] font-mono bg-muted/60 px-2 py-1.5 rounded break-all">
              a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6…
            </code>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-chart-2" />
              SQL AST Guardrails
            </CardTitle>
            <CardDescription>
              Verifikasi Abstract Syntax Tree setiap SQL yang dihasilkan LLM sebelum eksekusi.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <pre className="bg-muted/60 rounded-md p-3 text-[11px] font-mono overflow-x-auto">
              <code>{`// src/lib/guardrails.ts
const FORBIDDEN = ['DELETE','UPDATE','DROP','ALTER','TRUNCATE','INSERT','CREATE']
// 1. Parse AST dari SQL
// 2. Tolak jika node statement menyentung keyword FORBIDDEN
// 3. Paksa LIMIT 100 jika tidak ada
// 4. Hanya izinkan statement SELECT
// 5. Blok -> audit log severity=critical + return 403`}</code>
            </pre>
            <div className="text-xs text-muted-foreground">
              Setiap blok dicatat ke <code className="font-mono">AuditLog</code> dengan action{' '}
              <code className="font-mono">GUARDRAIL_BLOCK</code>.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="h-4 w-4 text-chart-3" />
              Scope Perusahaan
            </CardTitle>
            <CardDescription>
              Setiap kueri internal tetap dibatasi oleh <code className="font-mono">companyId</code> deployment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted/60 rounded-md p-3 text-[11px] font-mono overflow-x-auto">
              <code>{`// Pola di semua API route
const user = await getActiveUser()       // dari cookie x-active-user
const rows = await db.integration.findMany({
  where: { companyId: user.companyId },  // <-- scope perusahaan
})`}</code>
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-chart-4" />
              Audit Logging
            </CardTitle>
            <CardDescription>
              Setiap aksi penting dicatat dengan severity (info / warning / critical).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted/60 rounded-md p-3 text-[11px] font-mono overflow-x-auto">
              <code>{`await writeAudit({
  companyId, userId,
  action: 'SQL_EXECUTE',  // atau GUARDRAIL_BLOCK, USER_SWITCH, ...
  severity: 'info',       // info | warning | critical
  detail: { sql, rowCount, executionMs },
})`}</code>
            </pre>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {[
                'INTEGRATION_CREATE',
                'INTEGRATION_DELETE',
                'SQL_EXECUTE',
                'GUARDRAIL_BLOCK',
                'DOC_UPLOAD',
                'DOC_DELETE',
                'CHAT_SESSION_CREATE',
                'USER_SWITCH',
                'RAG_SEARCH',
              ].map((a) => (
                <Badge key={a} variant="outline" className="font-mono text-[10px]">
                  {a}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ---------- Tab 4: AI / LLM ----------
function LlmTab() {
  const [role, setRole] = useState<ActiveUser['role'] | null>(null)
  const [cfg, setCfg] = useState<PublicLlmConfig | null>(null)
  const [loading, setLoading] = useState(true)

  const [provider, setProvider] = useState('OPENAI_COMPATIBLE')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [embeddingProvider, setEmbeddingProvider] = useState('OPENAI_COMPATIBLE')
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState('')
  const [embeddingApiKey, setEmbeddingApiKey] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [showEmbeddingKey, setShowEmbeddingKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/me', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/llm-config', { cache: 'no-store' }).then((r) => r.json()),
    ])
      .then(([me, llm]) => {
        if (cancelled) return
        if (me) setRole(me.role)
        if (llm?.ok && llm.data) {
          setCfg(llm.data)
          setProvider(llm.data.provider || 'OPENAI_COMPATIBLE')
          setBaseUrl(llm.data.baseUrl || '')
          setModel(llm.data.model || '')
          setModels(llm.data.availableModels || [])
          setEmbeddingProvider(llm.data.embeddingProvider || 'OPENAI_COMPATIBLE')
          setEmbeddingBaseUrl(llm.data.embeddingBaseUrl || llm.data.baseUrl || '')
          setEmbeddingModel(llm.data.embeddingModel || '')
        }
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  const isAdmin = role === 'admin'

  async function handleFetchModels() {
    setSyncing(true)
    try {
      const res = await fetch('/api/llm-config/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey: apiKey || undefined }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? 'Gagal mengambil model.')
      }
      const list: string[] = json.data.models ?? []
      setModels(list)
      // Reconcile: if the saved/current model isn't in the fresh list, snap to the first.
      if (list.length > 0 && !list.includes(model)) setModel(list[0])
      toast.success(`${list.length} model ditemukan`, {
        description: baseUrl ? `Dari ${baseUrl}` : undefined,
      })
    } catch (e) {
      toast.error('Gagal mengambil daftar model', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSyncing(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          baseUrl,
          apiKey: apiKey || undefined,
          model: model || undefined,
          embeddingProvider,
          embeddingBaseUrl: embeddingBaseUrl || undefined,
          embeddingApiKey: embeddingApiKey || undefined,
          embeddingModel: embeddingModel || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? 'Gagal menyimpan.')
      }
      if (json.data) {
        setCfg(json.data)
        setApiKey('')
        setEmbeddingApiKey('')
      }
      toast.success('Konfigurasi LLM tersimpan')
    } catch (e) {
      toast.error('Gagal menyimpan konfigurasi', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Konfigurasi LLM
          </CardTitle>
          <CardDescription>
            Hubungkan penyedia OpenAI-compatible (base URL + API key). Model dipilih dari daftar yang
            diambil dari <code className="font-mono text-[11px]">{`{base_url}/models`}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* status row */}
          <div className="flex flex-wrap items-center gap-2">
            {cfg?.configured ? (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                <CheckCircle2 className="h-3 w-3" /> Terkonfigurasi
              </Badge>
            ) : (
              <Badge variant="secondary">Belum dikonfigurasi</Badge>
            )}
            {cfg?.apiKeyMasked && (
              <Badge variant="outline" className="font-mono text-[10px]">
                <KeyRound className="h-3 w-3" /> {cfg.apiKeyMasked}
              </Badge>
            )}
            {cfg?.lastModelSyncAt && (
              <span className="text-[11px] text-muted-foreground">
                Model disinkronkan {format(new Date(cfg.lastModelSyncAt), 'dd MMM yyyy, HH:mm', { locale: localeId })}
              </span>
            )}
          </div>

          {!isAdmin && (
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>Admin only</AlertTitle>
              <AlertDescription>
                Hanya admin yang dapat mengubah konfigurasi LLM. Anda dapat melihat pengaturan saat ini.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="llm-provider">Provider</Label>
              <Select value={provider} onValueChange={setProvider} disabled={!isAdmin}>
                <SelectTrigger id="llm-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPENAI_COMPATIBLE">OpenAI-Compatible</SelectItem>
                  <SelectItem value="OPENAI">OpenAI</SelectItem>
                  <SelectItem value="GROQ">Groq</SelectItem>
                  <SelectItem value="OPENROUTER">OpenRouter</SelectItem>
                  <SelectItem value="ANTHROPIC">Anthropic</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="llm-baseurl">Base URL</Label>
              <Input
                id="llm-baseurl"
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={!isAdmin}
                className="font-mono text-sm"
              />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="llm-apikey">API Key</Label>
              <div className="relative">
                <Input
                  id="llm-apikey"
                  type="text"
                  placeholder={cfg?.apiKeyMasked ? `${cfg.apiKeyMasked}  (biarkan kosong untuk mempertahankan)` : 'sk-...'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={!isAdmin}
                  className={cn(
                    'pr-10 font-mono text-sm',
                    !showKey && 'text-security-disc',
                  )}
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showKey ? 'Sembunyikan' : 'Tampilkan'}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="llm-model">Model</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleFetchModels}
                  disabled={!isAdmin || syncing || !baseUrl}
                  className="gap-1.5"
                >
                  {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Ambil Model
                </Button>
              </div>
              {models.length > 0 ? (
                <Select value={model} onValueChange={setModel} disabled={!isAdmin}>
                  <SelectTrigger id="llm-model">
                    <SelectValue placeholder="Pilih model" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {models.map((m) => (
                      <SelectItem key={m} value={m} className="font-mono text-xs">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="llm-model"
                  placeholder="gpt-4o-mini  (klik 'Ambil Model' untuk daftar)"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={!isAdmin}
                  className="font-mono text-sm"
                />
              )}
              {models.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Klik <strong>Ambil Model</strong> untuk memuat daftar dari {baseUrl || 'base URL'}.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <div>
              <div className="text-sm font-medium">Embedding RAG</div>
              <p className="text-xs text-muted-foreground">
                Dipakai untuk hybrid retrieval. OpenAI-compatible memakai{' '}
                <code className="rounded bg-muted px-1 font-mono text-[11px]">
                  /embeddings
                </code>{' '}
                dan Ollama memakai{' '}
                <code className="rounded bg-muted px-1 font-mono text-[11px]">
                  /api/embed
                </code>.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="embedding-provider">Provider Embedding</Label>
                <Select
                  value={embeddingProvider}
                  onValueChange={setEmbeddingProvider}
                  disabled={!isAdmin}
                >
                  <SelectTrigger id="embedding-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OPENAI_COMPATIBLE">OpenAI-Compatible</SelectItem>
                    <SelectItem value="OPENAI">OpenAI</SelectItem>
                    <SelectItem value="OLLAMA">Ollama API</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="embedding-baseurl">Base URL Embedding</Label>
                <Input
                  id="embedding-baseurl"
                  placeholder={
                    embeddingProvider === 'OLLAMA'
                      ? 'http://localhost:11434'
                      : 'https://api.openai.com/v1'
                  }
                  value={embeddingBaseUrl}
                  onChange={(e) => setEmbeddingBaseUrl(e.target.value)}
                  disabled={!isAdmin}
                  className="font-mono text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="embedding-model">Model Embedding</Label>
                <Input
                  id="embedding-model"
                  placeholder={
                    embeddingProvider === 'OLLAMA'
                      ? 'nomic-embed-text'
                      : 'text-embedding-3-small'
                  }
                  value={embeddingModel}
                  onChange={(e) => setEmbeddingModel(e.target.value)}
                  disabled={!isAdmin}
                  className="font-mono text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="embedding-apikey">API Key Embedding</Label>
                <div className="relative">
                  <Input
                    id="embedding-apikey"
                    type="text"
                    placeholder={
                      cfg?.embeddingApiKeyMasked
                        ? `${cfg.embeddingApiKeyMasked}  (biarkan kosong)`
                        : embeddingProvider === 'OLLAMA'
                          ? 'opsional untuk Ollama'
                          : 'sk-...'
                    }
                    value={embeddingApiKey}
                    onChange={(e) => setEmbeddingApiKey(e.target.value)}
                    disabled={!isAdmin}
                    className={cn(
                      'pr-10 font-mono text-sm',
                      !showEmbeddingKey && 'text-security-disc',
                    )}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowEmbeddingKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showEmbeddingKey ? 'Sembunyikan' : 'Tampilkan'}
                  >
                    {showEmbeddingKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={handleSave} disabled={!isAdmin || saving || !baseUrl} className="gap-1.5">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Simpan Konfigurasi
            </Button>
          </div>
        </CardContent>
      </Card>

      <Alert>
        <Plug className="h-4 w-4" />
        <AlertTitle>OpenAI-Compatible</AlertTitle>
        <AlertDescription>
          Semua panggilan AI (routing, Text-to-SQL, jawaban RAG, chat) diarahkan ke endpoint
          API ini. Sistem tidak menjalankan inference lokal; model internal hanya boleh dipakai
          jika tersedia sebagai endpoint API OpenAI-compatible.
        </AlertDescription>
      </Alert>
    </div>
  )
}

// ---------- Tab 5: Sistem ----------
function SystemTab() {
  const stack = [
    'Next.js 16',
    'TypeScript 5',
    'Prisma ORM',
    'SQLite',
    'socket.io',
    'z-ai-web-dev-sdk',
    'shadcn/ui',
    'Recharts',
    'Zustand',
    'TanStack Query',
    'Tailwind CSS 4',
    'date-fns',
  ]

  return (
    <div className="space-y-4 md:space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Cpu className="h-4 w-4" />
            Informasi Sistem
          </CardTitle>
          <CardDescription>Versi &amp; teknologi yang digunakan</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Versi Aplikasi</div>
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-muted-foreground" />
                <span className="text-lg font-semibold">v2.0.0</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Spesifikasi</div>
              <div className="text-sm font-medium">Multi-Source Knowledge &amp; Query Engine</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Mode</div>
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                Dedicated
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Boxes className="h-4 w-4" />
            Tech Stack
          </CardTitle>
          <CardDescription>Komponen teknologi yang membentuk sistem</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {stack.map((s) => (
              <Badge
                key={s}
                variant="secondary"
                className="bg-muted hover:bg-muted/70 transition-colors"
              >
                {s}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            Reset Data Pengembangan
          </CardTitle>
          <CardDescription>Operasi reset hanya untuk environment pengembangan</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <Server className="h-4 w-4" />
            <AlertTitle>Operasi Sisi-Server</AlertTitle>
            <AlertDescription>
              Untuk reset data pengembangan, jalankan perintah berikut di server:
              <pre className="mt-2 bg-muted/60 rounded-md p-2.5 text-[12px] font-mono overflow-x-auto">
                <code>bun run scripts/seed.ts</code>
              </pre>
              Tombol reset tidak disediakan di UI production karena operasi ini berpotensi
              menghapus seluruh data perusahaan.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------- helpers ----------
function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={cn('text-sm font-medium', mono && 'font-mono text-xs break-all')}>{value}</div>
    </div>
  )
}
