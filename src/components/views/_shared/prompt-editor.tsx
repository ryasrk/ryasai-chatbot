'use client'

/**
 * PromptEditor — reusable compact textarea for editing a single free-text
 * "context prompt" with a character counter, explicit Save state (loading +
 * "Saved"), an optional Clear button, and an optional "Insert default
 * template" affordance.
 *
 * Co-located under views/_shared because it is shared by the Knowledge,
 * Data Sources, and Prompt & Tools views. Kept presentational + local-state
 * only — no API calls here; the caller passes an async `onSave` so each view
 * controls its own endpoint and toasts (matches how other views gate fetches
 * behind their own handlers).
 *
 * Compact style per PRODUCT.md; English strings per AGENTS.md.
 */
import { useCallback, useEffect, useState } from 'react'
import { Save, Loader2, Eraser, FileText, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { extractError } from '@/lib/extract-error'

export interface PromptEditorProps {
  /** Current persisted value (from the server). The editor keeps an internal draft. */
  value: string
  /** Async save. Resolved value = persisted string so the editor can sync. */
  onSave: (next: string) => Promise<{ ok: boolean; value?: string; error?: unknown; savedAt?: number }>
  /** Hard char cap shown as `N/maxLength`. The caller trims on the server too. */
  maxLength: number
  /** Optional label above the textarea. */
  label?: string
  /** Stable id for the textarea (a11y + Label htmlFor). */
  id?: string
  /** Placeholder shown when empty. */
  placeholder?: string
  /** Helper text under the textarea (e.g. where it is injected). */
  helperText?: string
  /** If provided, a button inserts this into the textarea (replaces the draft). */
  defaultTemplate?: string
  /** Disable the whole editor (e.g. while parent is loading). */
  disabled?: boolean
  /** Hide the Save button (e.g. when the parent owns a single atomic save). */
  hideSaveButton?: boolean
  /** Extra className on the textarea. */
  textareaClassName?: string
}

/**
 * Saved-state flash lifetime: after a successful save the button shows
 * "Saved" for this long, then reverts to "Save". Long enough to read, short
 * enough not to imply a persistent badge.
 */
const SAVED_FLASH_MS = 1500

export function PromptEditor({
  value,
  onSave,
  maxLength,
  label,
  id = 'prompt-editor',
  placeholder = 'Optional context guidance for this source. Empty injects nothing.',
  helperText,
  defaultTemplate,
  disabled = false,
  hideSaveButton = false,
  textareaClassName,
}: PromptEditorProps) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Sync the local draft when the parent's persisted value changes (e.g. after
  // a parent-level refetch or when the detail panel switches documents). We do
  // NOT clear `savedAt` here: a successful save makes the parent re-render with
  // the newly persisted value, and resetting the flash on that same render
  // would hide "Saved" instantly. The flash timer (or a subsequent edit) clears it.
  useEffect(() => {
    setDraft((prev) => (prev === value ? prev : value))
  }, [value])

  const dirty = draft !== value
  const over = draft.length > maxLength

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value)
    setSavedAt(null)
  }, [])

  const handleSave = useCallback(async () => {
    if (saving || !dirty || over) return
    setSaving(true)
    try {
      const res = await onSave(draft)
      if (!res.ok) {
        toast.error(extractError(res.error, 'Failed to save prompt.'))
        return
      }
      // Adopt the server-normalized value so `dirty` clears.
      if (typeof res.value === 'string') setDraft(res.value)
      setSavedAt(res.savedAt ?? Date.now())
    } catch (e) {
      toast.error(extractError(e, 'Failed to save prompt.'))
    } finally {
      setSaving(false)
    }
  }, [saving, dirty, over, onSave, draft])

  const handleInsertDefault = useCallback(() => {
    if (!defaultTemplate) return
    setDraft(defaultTemplate)
    setSavedAt(null)
  }, [defaultTemplate])

  const handleClear = useCallback(() => {
    setDraft('')
    setSavedAt(null)
  }, [])

  const handleReset = useCallback(() => {
    setDraft(value)
    setSavedAt(null)
  }, [value])

  // Clear the "Saved" flash so the button returns to its idle state.
  useEffect(() => {
    if (savedAt === null) return
    const t = setTimeout(() => setSavedAt(null), SAVED_FLASH_MS)
    return () => clearTimeout(t)
  }, [savedAt])

  const trimmed = draft.trim()
  const isEmptyAfterTrim = trimmed.length === 0

  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={id} className="text-xs font-medium">{label}</label>
          <span
          className={`text-[10px] font-mono tabular-nums ${over ? 'text-destructive' : 'text-muted-foreground'}`}
          >
          {draft.length}/{maxLength}
        </span>
        </div>
      )}
      <Textarea
        id={id}
        value={draft}
        onChange={handleChange}
        placeholder={placeholder}
        rows={3}
        disabled={disabled || saving}
        className={`resize-y text-xs ${textareaClassName ?? ''}`}
      />
      {helperText && (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {!hideSaveButton && (
          <Button
            size="sm"
            onClick={handleSave}
            disabled={disabled || saving || !dirty || over}
            className="h-7 text-xs"
            icon={saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          >
            {saving ? 'Saving…' : savedAt !== null ? 'Saved' : 'Save'}
          </Button>
        )}
        {defaultTemplate && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleInsertDefault}
            disabled={disabled || saving}
            className="h-7 text-xs"
            icon={<FileText className="h-3 w-3" />}
            title="Replace the draft with a sensible starting template"
          >
            Insert default template
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClear}
          disabled={disabled || saving || isEmptyAfterTrim}
          className="h-7 text-xs"
          icon={<Eraser className="h-3 w-3" />}
          title="Empty the textarea"
        >
          Clear
        </Button>
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={disabled || saving}
            className="h-7 text-xs"
            icon={<RotateCcw className="h-3 w-3" />}
            title="Discard unsaved edits"
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  )
}
