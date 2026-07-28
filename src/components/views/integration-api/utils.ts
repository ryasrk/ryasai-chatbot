import { toast } from 'sonner'

export async function copyText(text: string, message: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(message)
  } catch {
    toast.error('Failed to copy')
  }
}

export function statusBadgeClass(status: number): string {
  if (status >= 200 && status < 300) return 'bg-success/15 text-success border-success/30'
  if (status >= 300 && status < 400) return 'bg-info/15 text-info border-info/30'
  if (status >= 400 && status < 500) return 'bg-warning/15 text-warning border-warning/30'
  return 'bg-destructive/15 text-destructive border-destructive/30'
}

export function methodBadgeClass(method: string): string {
  switch (method) {
    case 'GET':
      return 'text-info border-info/40'
    case 'POST':
      return 'text-success border-success/40'
    case 'PUT':
    case 'PATCH':
      return 'text-warning border-warning/40'
    case 'DELETE':
      return 'text-destructive border-destructive/40'
    default:
      return ''
  }
}

export function prettyBody(body: string): { text: string; isJson: boolean } {
  try {
    const parsed = JSON.parse(body)
    return { text: JSON.stringify(parsed, null, 2), isJson: true }
  } catch {
    return { text: body, isJson: false }
  }
}

export function downloadBody(text: string, isJson: boolean) {
  const blob = new Blob([text], { type: isJson ? 'application/json' : 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = isJson ? 'response.json' : 'response.txt'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
