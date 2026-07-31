'use client'

import { useState, useEffect, type FormEvent } from 'react'
import { Loader2, LogIn, KeyRound } from 'lucide-react'
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
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [ssoConfigured, setSsoConfigured] = useState(false)

  useEffect(() => {
    fetch('/api/auth/sso/status').then(r => r.json()).then(d => setSsoConfigured(d?.configured ?? false)).catch(() => {})
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const err = params.get('error')
    if (err === 'sso_not_configured') setError('SSO is not configured on this server.')
    else if (err === 'sso_state_mismatch') setError('SSO login failed: state mismatch. Try again.')
    else if (err === 'sso_missing_params') setError('SSO login failed: missing parameters.')
  }, [])

  async function handleSubmit(e: FormEvent) {
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <form onSubmit={handleSubmit}>
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-2xl">Sign In</CardTitle>
            <CardDescription>
              Enter admin credentials to continue.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </div>
            {error && (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="mr-2 h-4 w-4" />
              )}
              Sign In
            </Button>
            {ssoConfigured && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => { window.location.href = '/api/auth/sso/login' }}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                Sign in with SSO
              </Button>
            )}
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
