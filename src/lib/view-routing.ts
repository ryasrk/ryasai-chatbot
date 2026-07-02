export const VIEW_KEYS = [
  'dashboard',
  'chat',
  'integrations',
  'knowledge',
  'ai-config',
  'prompt-tools',
  'security',
  'settings',
] as const

export type ViewKey = (typeof VIEW_KEYS)[number]

export function isViewKey(value: string | null): value is ViewKey {
  return VIEW_KEYS.some((key) => key === value)
}

export function resolveViewFromSearch(search: string): ViewKey {
  const view = new URLSearchParams(search).get('view')
  return isViewKey(view) ? view : 'dashboard'
}
