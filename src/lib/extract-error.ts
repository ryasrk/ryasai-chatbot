/**
 * Extract a human-readable error message from an API response error field.
 * Handles both the typed error shape { code, message, hint? } and legacy string errors.
 *
 * The `hint` is APPENDED, not discarded. It used to be dropped, which silently threw away the
 * entire point of `classifyProviderFailure`: that function exists so a BYOK customer is told what
 * to DO about a failed credential ("re-enter the key", "add credit", "pick a model your provider
 * serves"), and `toTypedError` already carries the hint across the wire. This function was the
 * last hop, and it dropped the hint on the floor — every toast in the app showed the vague half
 * of the message. For a product whose #1 support burden is customer-supplied credentials, that
 * turned self-service fixes into support tickets.
 *
 * Joined with an em-dash separator so the shape stays a single string for every existing caller
 * (48 of them), and so the message alone still matches for callers that only match on it.
 */
export function extractError(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; hint?: unknown }
    if ('message' in e) {
      const message = String(e.message)
      const hint = typeof e.hint === 'string' && e.hint.trim() ? e.hint.trim() : ''
      return hint ? `${message} — ${hint}` : message
    }
  }
  return fallback
}
