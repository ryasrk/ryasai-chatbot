'use client'

import { useState } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { extractError } from '@/lib/extract-error'

export function RestCreateForm({ onCreated }: { onCreated: () => void }) {
  const [restName, setRestName] = useState('')
  const [restBaseUrl, setRestBaseUrl] = useState('')
  const [restAuthType, setRestAuthType] = useState('NONE')
  const [restToken, setRestToken] = useState('')
  const [restBasicUser, setRestBasicUser] = useState('')
  const [restBasicPass, setRestBasicPass] = useState('')
  const [restOauthUrl, setRestOauthUrl] = useState('')
  const [restOauthClientId, setRestOauthClientId] = useState('')
  const [restOauthClientSecret, setRestOauthClientSecret] = useState('')
  const [restOauthScope, setRestOauthScope] = useState('')
  const [restCreating, setRestCreating] = useState(false)

  const handleCreateRestConnector = async () => {
    const name = restName.trim()
    const baseUrl = restBaseUrl.trim()
    if (!name || !baseUrl) {
      toast.error('Name and Base URL are required.')
      return
    }
    try { new URL(baseUrl) } catch {
      toast.error('Invalid Base URL.')
      return
    }
    if (restAuthType !== 'NONE' && !restToken.trim() && restAuthType !== 'BASIC' && restAuthType !== 'OAUTH2') {
      toast.error('Token is required for authentication.')
      return
    }
    if (restAuthType === 'BASIC' && !restBasicUser.trim() && !restBasicPass.trim()) {
      toast.error('Username and password are required for Basic Auth.')
      return
    }
    if (restAuthType === 'OAUTH2' && (!restOauthUrl.trim() || !restOauthClientId.trim() || !restOauthClientSecret.trim())) {
      toast.error('Token URL, Client ID, and Client Secret are required for OAuth2.')
      return
    }
    setRestCreating(true)
    try {
      let authConfig: Record<string, unknown> = {}
      if (restAuthType === 'BEARER') {
        authConfig = { token: restToken }
      } else if (restAuthType === 'API_KEY_HEADER') {
        authConfig = { headerName: 'X-API-Key', apiKey: restToken }
      } else if (restAuthType === 'BASIC') {
        authConfig = { username: restBasicUser, password: restBasicPass }
      } else if (restAuthType === 'OAUTH2') {
        authConfig = {
          tokenUrl: restOauthUrl,
          clientId: restOauthClientId,
          clientSecret: restOauthClientSecret,
          ...(restOauthScope.trim() ? { scope: restOauthScope } : {}),
        }
      }
      const res = await fetch('/api/data-sources/rest-connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          baseUrl,
          authType: restAuthType,
          authConfig,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(extractError(json.error, 'Failed to create connector.'))
      toast.success('REST API connector created.')
      setRestName('')
      setRestBaseUrl('')
      setRestToken('')
      setRestBasicUser('')
      setRestBasicPass('')
      setRestOauthUrl('')
      setRestOauthClientId('')
      setRestOauthClientSecret('')
      setRestOauthScope('')
      setRestAuthType('NONE')
      onCreated()
    } catch (e) {
      toast.error('Failed to create REST API connector', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setRestCreating(false)
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
        <Input
          value={restName}
          onChange={(e) => setRestName(e.target.value)}
          placeholder="Connector name"
          className="md:col-span-1"
        />
        <Input
          value={restBaseUrl}
          onChange={(e) => setRestBaseUrl(e.target.value)}
          placeholder="https://api.example.com"
          className="md:col-span-2 font-mono text-sm"
        />
        <Select value={restAuthType} onValueChange={setRestAuthType}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="NONE">No Auth</SelectItem>
            <SelectItem value="BEARER">Bearer Token</SelectItem>
            <SelectItem value="API_KEY_HEADER">API Key Header</SelectItem>
            <SelectItem value="BASIC">Basic Auth</SelectItem>
            <SelectItem value="OAUTH2">OAuth2 (Client Credentials)</SelectItem>
          </SelectContent>
        </Select>
        <Button
          onClick={handleCreateRestConnector}
          disabled={restCreating || !restName.trim() || !restBaseUrl.trim()}
        >
          {restCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add REST
        </Button>
      </div>

      {(restAuthType === 'BEARER' || restAuthType === 'API_KEY_HEADER') && (
        <Input
          value={restToken}
          onChange={(e) => setRestToken(e.target.value)}
          placeholder={restAuthType === 'BEARER' ? 'Bearer token' : 'API key'}
          type="password"
          className="font-mono text-sm"
        />
      )}

      {restAuthType === 'BASIC' && (
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={restBasicUser}
            onChange={(e) => setRestBasicUser(e.target.value)}
            placeholder="Username"
            className="font-mono text-sm"
          />
          <Input
            value={restBasicPass}
            onChange={(e) => setRestBasicPass(e.target.value)}
            placeholder="Password"
            type="password"
            className="font-mono text-sm"
          />
        </div>
      )}

      {restAuthType === 'OAUTH2' && (
        <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
          <Input
            value={restOauthUrl}
            onChange={(e) => setRestOauthUrl(e.target.value)}
            placeholder="Token URL (https://auth.example.com/oauth/token)"
            className="font-mono text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={restOauthClientId}
              onChange={(e) => setRestOauthClientId(e.target.value)}
              placeholder="Client ID"
              className="font-mono text-sm"
            />
            <Input
              value={restOauthClientSecret}
              onChange={(e) => setRestOauthClientSecret(e.target.value)}
              placeholder="Client Secret"
              type="password"
              className="font-mono text-sm"
            />
          </div>
          <Input
            value={restOauthScope}
            onChange={(e) => setRestOauthScope(e.target.value)}
            placeholder="Scope (optional, e.g. read:api)"
            className="font-mono text-sm"
          />
        </div>
      )}
    </>
  )
}
