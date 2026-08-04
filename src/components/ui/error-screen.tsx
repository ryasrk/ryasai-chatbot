'use client'
import { ShieldAlert, CreditCard, Lock, Loader2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorScreenProps {
  type: 'forbidden' | 'license' | 'unauthorized'
  message?: string
  onRetry?: () => void
  /** When true, the Try Again button shows a spinner and is disabled. */
  retrying?: boolean
  /** Secondary action shown after a failed retry (license type only). */
  onSignup?: () => void
}

export function ErrorScreen({ type, message, onRetry, retrying, onSignup }: ErrorScreenProps) {
  const config = {
    forbidden: { icon: ShieldAlert, title: 'Access Denied', desc: message || 'You do not have permission to perform this action. Contact your organization administrator.' },
    license: { icon: CreditCard, title: 'License Required', desc: message || 'Your license is no longer valid. Please contact your administrator to renew.' },
    unauthorized: { icon: Lock, title: 'Session Expired', desc: message || 'Your session has expired. Please sign in again.' },
  }
  const { icon: Icon, title, desc } = config[type]

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="max-w-md w-full rounded-lg border bg-background p-6 text-center space-y-4">
        <Icon className="h-12 w-12 mx-auto text-muted-foreground" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{desc}</p>
        {onRetry && (
          <Button onClick={onRetry} variant="outline" className="w-full" disabled={retrying}>
            {retrying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Try Again
          </Button>
        )}
        {type === 'license' && onSignup && (
          <Button onClick={onSignup} className="w-full">
            <UserPlus className="mr-2 h-4 w-4" />
            Sign Up Again
          </Button>
        )}
        {type === 'unauthorized' && (
          <Button onClick={() => window.location.reload()} className="w-full">
            Sign In
          </Button>
        )}
      </div>
    </div>
  )
}
