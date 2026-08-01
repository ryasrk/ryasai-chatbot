'use client'

import { useState, useEffect, type FormEvent } from 'react'
import { Loader2, LogIn, KeyRound, UserPlus, BadgeCheck, ArrowLeft } from 'lucide-react'
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
  defaultMode?: 'login' | 'signup'
  startStep?: 0 | 1
}

export function LoginView({ onSuccess, defaultMode = 'login', startStep = 0 }: LoginViewProps) {
  const [mode, setMode] = useState<'login' | 'signup'>(defaultMode)
  const [signupStep, setSignupStep] = useState<0 | 1>(startStep)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [oidcConfigured, setOidcConfigured] = useState(false)
  const [samlConfigured, setSamlConfigured] = useState(false)

  // Login form state
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // Signup step 0: register
  const [name, setName] = useState('')

  // Signup step 1: license
  const [licenseKey, setLicenseKey] = useState('')
  const [orgName, setOrgName] = useState('')

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

  function resetSignup() {
    setSignupStep(0)
    setName('')
    setLicenseKey('')
    setOrgName('')
    setError(null)
  }

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
      if (res.ok) { onSuccess(); return }
      const data = await res.json().catch(() => ({}))
      setError(data?.error || 'Invalid email or password.')
    } catch {
      setError('Unable to connect to the server.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      })
      if (res.ok) {
        setSignupStep(1)
        return
      }
      const data = await res.json().catch(() => ({}))
      setError(data?.error || 'Registration failed.')
    } catch {
      setError('Unable to connect to the server.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleActivateLicense(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/activate-license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey, organizationName: orgName || undefined }),
      })
      if (res.ok) { onSuccess(); return }
      const data = await res.json().catch(() => ({}))
      setError(data?.error || 'License activation failed.')
    } catch {
      setError('Unable to connect to the server.')
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
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground mt-2" onClick={() => { setMode('signup'); resetSignup() }}>
                No account? Sign up
              </button>
            </CardFooter>
          </form>
        ) : signupStep === 0 ? (
          <form onSubmit={handleRegister}>
            <CardHeader className="space-y-1 text-center">
              <CardTitle className="text-2xl">Create Account</CardTitle>
              <CardDescription>Step 1 of 2 — Enter your details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
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
              {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
                Continue
              </Button>
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground mt-2" onClick={() => { setMode('login'); resetSignup() }}>
                Already have an account? Sign in
              </button>
            </CardFooter>
          </form>
        ) : (
          <form onSubmit={handleActivateLicense}>
            <CardHeader className="space-y-1 text-center">
              <CardTitle className="text-2xl">Activate License</CardTitle>
              <CardDescription>Step 2 of 2 — Enter your license key</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-emerald-600">
                <BadgeCheck className="h-4 w-4" />
                Account created: {email}
              </div>
              <div className="space-y-2">
                <Label htmlFor="orgName">Organization Name (optional)</Label>
                <Input id="orgName" value={orgName} onChange={(e) => setOrgName(e.target.value)} disabled={submitting} placeholder="Acme Corporation" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="licenseKey">License Key</Label>
                <Input id="licenseKey" required value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)} disabled={submitting} placeholder="RYASAI-XXXX-XXXX-XXXX" />
              </div>
              {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                Activate & Continue
              </Button>
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1" onClick={() => setSignupStep(0)}>
                <ArrowLeft className="h-3 w-3" /> Back
              </button>
            </CardFooter>
          </form>
        )}
      </Card>
    </div>
  )
}
