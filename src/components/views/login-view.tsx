'use client'

import { useState, useEffect, type FormEvent } from 'react'
import Image from 'next/image'
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

// The login screen is a fixed brand surface, not a themed one: it always
// renders the Neo-Olympian obsidian/gold hero + card look, regardless of
// which of the 5 in-app themes (or light/dark mode) the user has picked in
// Settings — that preference only applies once they're past the door. These
// are the same values as THEME_CSS.slate.dark in src/lib/themes.ts, scoped
// locally onto the root element so every shadcn primitive below (Card,
// Button, Input …) picks them up via the var(--*) tokens it already uses,
// with zero per-component styling.
const NEO_OLYMPIAN_VARS = {
  '--radius': '10px',
  '--background': 'oklch(0.143 0.004 227.5)',
  '--foreground': 'oklch(0.934 0.014 88.7)',
  '--card': 'oklch(0.189 0.006 236.9)',
  '--card-foreground': 'oklch(0.934 0.014 88.7)',
  '--popover': 'oklch(0.189 0.006 236.9)',
  '--popover-foreground': 'oklch(0.934 0.014 88.7)',
  '--primary': 'oklch(0.737 0.101 82.7)',
  '--primary-foreground': 'oklch(0.16 0.01 88)',
  '--secondary': 'oklch(0.24 0.008 236.9)',
  '--secondary-foreground': 'oklch(0.90 0.012 88.7)',
  '--muted': 'oklch(0.22 0.006 236.9)',
  '--muted-foreground': 'oklch(0.63 0.012 93.6)',
  '--accent': 'oklch(0.875 0.097 86.5)',
  '--accent-foreground': 'oklch(0.16 0.01 88)',
  '--destructive': 'oklch(0.477 0.106 21.9)',
  '--destructive-foreground': 'oklch(0.95 0.01 88.7)',
  '--success': 'oklch(0.62 0.10 155)',
  '--success-foreground': 'oklch(0.15 0.02 155)',
  '--border': 'oklch(0.30 0.02 85)',
  '--input': 'oklch(0.30 0.02 85)',
  '--ring': 'oklch(0.737 0.101 82.7)',
  // next/font's --font-cinzel var lives on <body> (see layout.tsx) and is
  // available regardless of the active theme — only the *activation* of
  // --font-display is normally theme-gated (globals.css), so redefining it
  // here guarantees the serif brand title renders even if the user's saved
  // theme is e.g. Forest.
  '--font-display': 'var(--font-cinzel)',
} as React.CSSProperties

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
      const errMsg = typeof data?.error === 'string' ? data.error : data?.error?.message
      setError(errMsg || 'Invalid email or password.')
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
      const errMsg = typeof data?.error === 'string' ? data.error : data?.error?.message
      setError(errMsg || 'Registration failed.')
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
      const errMsg = typeof data?.error === 'string' ? data.error : data?.error?.message
      setError(errMsg || 'License activation failed.')
    } catch {
      setError('Unable to connect to the server.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      data-theme="slate"
      style={NEO_OLYMPIAN_VARS}
      className="flex min-h-screen bg-background md:items-stretch"
    >
      <div className="relative hidden md:flex md:w-1/2 lg:w-[58%] shrink-0 items-end overflow-hidden">
          <Image
            src="/neo-olympian-hero.webp"
            alt="A classical marble statue transitioning into golden AI circuitry"
            fill
            priority
            className="object-cover object-top"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/10 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-transparent to-background/90" />
          <div className="relative z-10 p-10 lg:p-14 space-y-3">
            <div className="flex items-center gap-2 text-[11px] tracking-[0.3em] text-primary uppercase">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              Divine Intelligence
            </div>
            <h1 className="brand-title text-3xl lg:text-4xl text-foreground leading-tight max-w-md">
              Ancient Intelligence.
              <br />
              Engineered for the Future.
            </h1>
            <p className="text-xs text-muted-foreground tracking-wide">
              System online · ryasai enterprise AI platform
            </p>
          </div>
        </div>
      <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm backdrop-blur-xl bg-card/85">
        {mode === 'login' ? (
          <form onSubmit={handleLogin}>
            <CardHeader className="space-y-1 text-center">
              <CardTitle className="brand-title text-2xl">Sign In</CardTitle>
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
              <Button
                type="submit"
                className="w-full"
                icon={submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                disabled={submitting}
              >
                Sign In
              </Button>
              {(oidcConfigured || samlConfigured) && (
                <div className="flex flex-col gap-2 w-full">
                  {oidcConfigured && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      icon={<KeyRound className="h-4 w-4" />}
                      onClick={() => { window.location.href = '/api/auth/sso/login' }}
                    >
                      Sign in with SSO
                    </Button>
                  )}
                  {samlConfigured && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      icon={<KeyRound className="h-4 w-4" />}
                      onClick={() => { window.location.href = '/api/auth/saml/login' }}
                    >
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
              <CardTitle className="brand-title text-2xl">Create Account</CardTitle>
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
              <Button
                type="submit"
                className="w-full"
                icon={submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                disabled={submitting}
              >
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
              <CardTitle className="brand-title text-2xl">Activate License</CardTitle>
              <CardDescription>Step 2 of 2 — Enter your license key</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-success">
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
              <Button
                type="submit"
                className="w-full"
                icon={submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                disabled={submitting}
              >
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
    </div>
  )
}
