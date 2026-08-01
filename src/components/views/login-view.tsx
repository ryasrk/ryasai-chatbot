'use client'

import { useState, useEffect, type FormEvent } from 'react'
import { Loader2, LogIn, KeyRound, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

interface LoginViewProps {
  onSuccess: () => void
}

export function LoginView({ onSuccess }: LoginViewProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [orgName, setOrgName] = useState('')
  const [slug, setSlug] = useState('')
  const [licenseKey, setLicenseKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [oidcConfigured, setOidcConfigured] = useState(false)
  const [samlConfigured, setSamlConfigured] = useState(false)

  useEffect(() => {
    fetch('/api/auth/sso/status')
      .then(r => r.json())
      .then(d => {
        setOidcConfigured(d?.oidc ?? false)
        setSamlConfigured(d?.saml ?? false)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const err = params.get('error')
    if (err === 'sso_not_configured') setError('SSO is not configured on this server.')
    else if (err === 'sso_state_mismatch') setError('SSO login failed: state mismatch. Try again.')
    else if (err === 'sso_missing_params') setError('SSO login failed: missing parameters.')
  }, [])

  async function handleLogin(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (res.ok) {
        onSuccess()
        return
      }
      const data = await res.json().catch(() => ({}))
      setError(data?.error || 'Incorrect email or password.')
    } catch {
      setError('Unable to connect to the server. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSignup(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationName: orgName, slug, name, email, password, licenseKey }),
      })
      if (res.ok) {
        onSuccess()
        return
      }
      const data = await res.json().catch(() => ({}))
      setError(data?.error || 'Signup failed.')
    } catch {
      setError('Unable to connect to the server. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        {mode === 'login' ? (
          <form onSubmit={handleLogin}>
            <CardHeader className="space-y-1 text-center">
              <CardTitle className="text-2xl">Sign In</CardTitle>
              <CardDescription>Enter credentials to continue.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={submitting} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={submitting} />
              </div>
              {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogIn className="mr-2 h-4 w-4" />}
                Sign In
              </Button>
              {(oidcConfigured || samlConfigured) && (
                <div className="flex flex-col gap-2 w-full">
                  {oidcConfigured && (
                    <Button type="button" variant="outline" className="w-full" onClick={() => { window.location.href = '/api/auth/sso/login' }}>
                      <KeyRound className="mr-2 h-4 w-4" />
                      Sign in with SSO
                    </Button>
                  )}
                  {samlConfigured && (
                    <Button type="button" variant="outline" className="w-full" onClick={() => { window.location.href = '/api/auth/saml/login' }}>
                      <KeyRound className="mr-2 h-4 w-4" />
                      Sign in with SAML
                    </Button>
                  )}
                </div>
              )}
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground mt-2" onClick={() => { setMode('signup'); setError(null) }}>
                No account? Sign up with a license key
              </button>
            </CardFooter>
          </form>
        ) : (
          <form onSubmit={handleSignup}>
            <CardHeader className="space-y-1 text-center">
              <CardTitle className="text-2xl">Sign Up</CardTitle>
              <CardDescription>Create a new organization with a license key.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="orgName">Organization Name</Label>
                <Input id="orgName" required value={orgName} onChange={(e) => setOrgName(e.target.value)} disabled={submitting} placeholder="Acme Corporation" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="slug">URL Slug</Label>
                <Input id="slug" required value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} disabled={submitting} placeholder="acme-corp" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">Your Name</Label>
                <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} placeholder="John Doe" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={submitting} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} disabled={submitting} placeholder="Min 8 characters" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="licenseKey">License Key</Label>
                <Input id="licenseKey" required value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)} disabled={submitting} placeholder="RYASAI-XXXX-XXXX-XXXX" />
              </div>
              {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
                Create Organization
              </Button>
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground mt-2" onClick={() => { setMode('login'); setError(null) }}>
                Already have an account? Sign in
              </button>
            </CardFooter>
          </form>
        )}
      </Card>
    </div>
  )
}
