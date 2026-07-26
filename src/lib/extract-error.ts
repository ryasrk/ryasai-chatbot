/**
 * Extract a human-readable error message from an API response error field.
 * Handles both the typed error shape { code, message, hint? } and legacy string errors.
 */
export function extractError(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: string }).message)
  }
  return fallback
}
