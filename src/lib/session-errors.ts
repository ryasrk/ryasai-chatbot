/**
 * The session error classes, in a leaf module: `errors.ts` maps them to typed responses and `session.ts` throws them,
 * and keeping them here is what stops those two files importing each other. `session.ts` re-exports all three, so
 * every existing import path keeps working.
 */
export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(message = 'No active session.') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN'
  constructor(message = 'Insufficient permissions.') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export class LicenseError extends Error {
  readonly code = 'LICENSE_INVALID'
  readonly reason: string
  constructor(reason: string = 'expired', message?: string) {
    const messages: Record<string, string> = {
      expired: 'License has expired. Please renew your license.',
      deactivated: 'License has been deactivated. Please contact support.',
      unreachable: 'License server unreachable and grace period has expired. Please check your internet connection.',
      unpaid: 'Subscription required — buy a license to continue',
    }
    super(message ?? messages[reason] ?? 'License is no longer valid.')
    this.name = 'LicenseError'
    this.reason = reason
  }
}
