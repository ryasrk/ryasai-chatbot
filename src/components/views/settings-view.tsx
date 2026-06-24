'use client'

import { useEffect, useState } from 'react'
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
} from 'lucide-react'
import { format } from 'date-fns'
import { id as localeId } from 'date-fns/locale'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
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
import type { ActiveUser } from '@/lib/types'

const id = (n: number) => n.toLocaleString('id-ID')

const ROLE_STYLES: Record<string, string> = {
  admin: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  manager: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  staff: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
}

const initials = (name: string) =>
  name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

interface UserRow {
  id: string
  name: string
  email: string
  role: 'admin' | 'manager' | 'staff'
  avatarColor: string
  isActive: boolean
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
          <TabsTrigger value="users" className="gap-1.5">
            <UserIcon className="h-3.5 w-3.5" />
            Pengguna
          </TabsTrigger>
          <TabsTrigger value="security" className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Keamanan
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
      <TabsContent value="users" className="mt-4">
        <UsersTab />
      </TabsContent>
      <TabsContent value="security" className="mt-4">
        <SecurityTab />
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
                <div className="text-xs text-muted-foreground mb-1">Peran (RBAC)</div>
                <Badge className={cn('capitalize', ROLE_STYLES[user.role])}>{user.role}</Badge>
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
          <CardDescription>Tenant saat ini</CardDescription>
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
        <AlertTitle>Kontrol Akses Berbasis Peran (RBAC)</AlertTitle>
        <AlertDescription>
          Sistem menggunakan RBAC dengan 3 peran:{' '}
          <strong>admin</strong> (akses penuh), <strong>manager</strong> (kelola integrasi &amp;
          dokumen), <strong>staff</strong> (chat &amp; baca). Anda dapat berganti peran melalui menu
          pengguna di kanan atas untuk mencoba alur RBAC pada demo.
        </AlertDescription>
      </Alert>
    </div>
  )
}

// ---------- Tab 2: Pengguna ----------
function UsersTab() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/users', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Gagal memuat daftar pengguna.')
        return r.json()
      })
      .then((d: { items: UserRow[] }) => !cancelled && setUsers(d.items ?? []))
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <UserIcon className="h-4 w-4" />
          Daftar Pengguna
        </CardTitle>
        <CardDescription>{id(users.length)} pengguna pada perusahaan ini</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[200px]">Pengguna</TableHead>
                <TableHead className="w-[110px]">Peran</TableHead>
                <TableHead className="w-[110px]">Status</TableHead>
                <TableHead className="w-[140px]">Dibuat</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                    Belum ada pengguna.
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback
                            className="text-[11px] font-semibold text-white"
                            style={{ backgroundColor: u.avatarColor || 'oklch(0.55 0.18 250)' }}
                          >
                            {initials(u.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{u.name}</div>
                          <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className={cn('capitalize', ROLE_STYLES[u.role])}>{u.role}</Badge>
                    </TableCell>
                    <TableCell>
                      {u.isActive ? (
                        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                          Aktif
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Nonaktif</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(u.createdAt), 'dd MMM yyyy', { locale: localeId })}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------- Tab 3: Keamanan ----------
function SecurityTab() {
  return (
    <div className="space-y-4 md:space-y-6">
      <Alert>
        <Lock className="h-4 w-4" />
        <AlertTitle>Arsitektur Keamanan Multi-Lapis</AlertTitle>
        <AlertDescription>
          Empat lapisan keamanan utama melindungi data perusahaan: enkripsi kredensial, validasi
          SQL berbasis AST, isolasi multi-tenant, serta audit logging menyeluruh.
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
              Isolasi Multi-Tenant
            </CardTitle>
            <CardDescription>
              Setiap kueri DB di-scope dengan <code className="font-mono">companyId</code> dari sesi aktif.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted/60 rounded-md p-3 text-[11px] font-mono overflow-x-auto">
              <code>{`// Pola di semua API route
const user = await getActiveUser()       // dari cookie x-active-user
const rows = await db.integration.findMany({
  where: { companyId: user.companyId },  // <-- scope tenant
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

// ---------- Tab 4: Sistem ----------
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
                Multi-tenant
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
            Reset Data Demo
          </CardTitle>
          <CardDescription>Bagaimana mereset data demo ke kondisi awal</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <Server className="h-4 w-4" />
            <AlertTitle>Operasi Sisi-Server</AlertTitle>
            <AlertDescription>
              Untuk reset data demo, jalankan perintah berikut di server:
              <pre className="mt-2 bg-muted/60 rounded-md p-2.5 text-[12px] font-mono overflow-x-auto">
                <code>bun run scripts/seed.ts</code>
              </pre>
              Tombol reset tidak disediakan di UI karena operasi ini bersifat admin-only dan
              berpotensi menghapus seluruh data tenant.
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
