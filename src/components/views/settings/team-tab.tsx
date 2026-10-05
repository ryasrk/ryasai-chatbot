'use client'

import { useEffect, useState } from 'react'
import { Loader2, Crown, Mail, Copy, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TableSkeleton, ErrorState } from '@/components/ui/view-states'
import { useDelayedLoading } from '@/hooks/use-delayed-loading'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { extractError } from '@/lib/extract-error'
import type { ActiveUser } from '@/lib/types'
import { initials } from '@/components/views/settings/initials'

export interface TeamMember {
  id: string
  name: string
  email: string
  role: string
  avatarColor: string | null
  isActive: boolean
  createdAt: string
}

export function roleBadge(role: string) {
  if (role === 'admin') return <Badge variant="warning" className="gap-1 text-[10px]"><Crown className="h-3 w-3" />Admin</Badge>
  if (role === 'analyst') return <Badge variant="info" className="text-[10px]">Analyst</Badge>
  return <Badge variant="secondary" className="text-[10px]">Viewer</Badge>
}

export function TeamTab() {
  const [me, setMe] = useState<ActiveUser | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const showSkeleton = useDelayedLoading(loading)
  const [error, setError] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('viewer')
  const [inviting, setInviting] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)

  const isAdmin = me?.role === 'admin'

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [meRes, usersRes] = await Promise.all([
        fetch('/api/me', { cache: 'no-store' }),
        fetch('/api/users', { cache: 'no-store' }),
      ])
      if (!meRes.ok) throw new Error('Failed to load profile.')
      if (!usersRes.ok) {
        const body = await usersRes.json().catch(() => ({}))
        throw new Error(extractError(body, 'Failed to load team members.'))
      }
      const [meData, usersData] = await Promise.all([meRes.json(), usersRes.json()])
      setMe(meData as ActiveUser)
      setMembers((usersData as { items: TeamMember[] }).items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviting(true)
    setInviteUrl(null)
    try {
      const res = await fetch('/api/auth/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(extractError(data, 'Invitation failed.')); return }
      setInviteUrl(data.inviteUrl as string)
      toast.success('Invitation created. Copy the link to share.')
      setInviteEmail('')
    } catch {
      toast.error('Unable to connect to the server.')
    } finally {
      setInviting(false)
    }
  }

  async function handleRoleChange(id: string, role: string) {
    const res = await fetch(`/api/users/${id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { toast.error(extractError(data, 'Failed to update role.')); return }
    toast.success('Role updated.')
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, role } : m)))
  }

  async function handleDeactivate(id: string, name: string) {
    if (!window.confirm(`Deactivate ${name}? They will lose access immediately.`)) return
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { toast.error(extractError(data, 'Failed to deactivate user.')); return }
    toast.success('User deactivated.')
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, isActive: false } : m)))
  }

  if (loading) return showSkeleton ? <TableSkeleton rows={4} cols={4} /> : null
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="space-y-3">
      {isAdmin && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs flex items-center gap-2">
              <Mail className="h-3.5 w-3.5" />
              Invite Team Member
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-2 items-end">
              <div className="flex-1 w-full space-y-1.5">
                <Label htmlFor="invite-email" className="text-xs">Email</Label>
                <Input id="invite-email" type="email" placeholder="colleague@company.com" required
                  value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} disabled={inviting} />
              </div>
              <div className="w-full sm:w-32 space-y-1.5">
                <Label className="text-xs">Role</Label>
                <Select value={inviteRole} onValueChange={setInviteRole} disabled={inviting}>
                  <SelectTrigger className="w-full" size="sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">Viewer</SelectItem>
                    <SelectItem value="analyst">Analyst</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                size="sm"
                icon={inviting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
                disabled={inviting || !inviteEmail}
              >
                Send Invite
              </Button>
            </form>
            {inviteUrl && (
              <div className="mt-2.5 flex items-center gap-2 rounded-md border bg-muted/40 p-2">
                <code className="flex-1 truncate text-[11px] font-mono">{inviteUrl}</code>
                <Button size="sm" variant="outline" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => { void navigator.clipboard.writeText(inviteUrl); toast.success('Link copied.') }}>
                  Copy
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Member</TableHead>
                <TableHead className="text-xs">Role</TableHead>
                <TableHead className="text-xs">Status</TableHead>
                {isAdmin && <TableHead className="text-xs text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-7 w-7">
                        <AvatarFallback className="text-[10px] font-semibold text-white"
                          style={{ backgroundColor: m.avatarColor ?? 'oklch(0.55 0.18 250)' }}>
                          {initials(m.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate">{m.name}</div>
                        <div className="text-[11px] text-muted-foreground truncate">{m.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{roleBadge(m.role)}</TableCell>
                  <TableCell>
                    {m.isActive
                      ? <Badge variant="success" className="text-[10px]">Active</Badge>
                      : <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        {/* Your own row is read-only, for the same reason the deactivate button below is:
                            the API refuses a self role change (otherwise the last admin locks the org out
                            of user management), so leaving the control live would offer an action that can
                            only fail. `title` says why instead of leaving the user to guess. */}
                        <Select value={m.role} onValueChange={(role) => void handleRoleChange(m.id, role)}
                          disabled={m.id === me?.userId}>
                          <SelectTrigger size="sm" className="h-7 w-28 text-xs"
                            title={m.id === me?.userId ? 'You cannot change your own role. Ask another admin.' : undefined}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="viewer">Viewer</SelectItem>
                            <SelectItem value="analyst">Analyst</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive hover:text-destructive"
                          disabled={m.id === me?.userId || !m.isActive}
                          onClick={() => void handleDeactivate(m.id, m.name)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
