'use client'

import { useEffect, useState } from 'react'
import { Table2, Pencil, Lock, Unlock, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { extractError } from '@/lib/extract-error'
import { useActiveUser } from '@/hooks/use-active-user'
import { PromptEditor } from '@/components/views/_shared/prompt-editor'
import { INTEGRATION_PROMPT_MAX, TABLE_DESCRIPTION_MAX } from '@/lib/integration-limits'

/**
 * Per-table description editor — admin-only. Shows the current description
 * with a "manual" lock badge when `manualDescription` is true (the enrichment
 * step skips manual rows). Editing sends PATCH /api/integrations/{id}/schema
 * `{ table, description }`; "Reset to auto" sends `description: null` to clear
 * the manual lock and mark the row for re-enrichment.
 *
 * NOTE: the schema GET route does not currently return `description` or
 * `manualDescription` (agent B's route extension is not in this working tree),
 * so the editor starts empty until the GET is extended. Saving still works
 * once agent B adds the PATCH handler.
 */
export function TableDescriptionEditor({
  integrationId,
  tableName,
  description,
  manual,
}: {
  integrationId: string
  tableName: string
  description: string
  manual: boolean
}) {
  const { user } = useActiveUser()
  const isAdmin = user?.role === 'admin'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(description)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(description)
  }, [description])

  const save = async (value: string | null) => {
    setSaving(true)
    try {
      const res = await fetch(`/api/integrations/${integrationId}/schema`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: tableName, description: value }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        toast.error(extractError(json?.error, 'Failed to save table description.'))
        return
      }
      setDraft(value ?? '')
      toast.success(
        value === null
          ? 'Reset to auto. The table will be re-enriched on next refresh.'
          : 'Table description saved',
      )
      setEditing(false)
    } catch {
      toast.error('Network error while saving table description.')
    } finally {
      setSaving(false)
    }
  }

  if (!isAdmin) {
    // Non-admins: read-only view of the description (no edit affordance).
    return description ? (
      <div className="text-xs text-muted-foreground italic">&ldquo;{description}&rdquo;</div>
    ) : null
  }

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Description</span>
            {manual ? (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
                <Lock className="h-2.5 w-2.5" /> manual
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
                <Unlock className="h-2.5 w-2.5" /> auto
              </Badge>
            )}
          </div>
          {description ? (
            <p className="text-xs text-foreground/80 mt-0.5 break-words">{description}</p>
          ) : (
            <p className="text-xs text-muted-foreground italic mt-0.5">No description yet.</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => { setDraft(description); setEditing(true) }}
            icon={<Pencil className="h-3 w-3" />}
          >
            Edit
          </Button>
          {manual && (
            <button
              type="button"
              onClick={() => save(null)}
              disabled={saving}
              className="text-xs text-primary hover:underline disabled:opacity-50"
            >
              {saving ? 'Resetting…' : 'Reset to auto'}
            </button>
          )}
        </div>
      </div>
    )
  }

  // Inline editor
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Description for {tableName}</span>
        <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
          {draft.length}/{TABLE_DESCRIPTION_MAX}
        </span>
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, TABLE_DESCRIPTION_MAX))}
        rows={3}
        className="resize-y text-xs"
        placeholder="Describe what this table holds, in plain language. Used by Text-to-SQL."
        disabled={saving}
      />
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => save(draft.trim())}
          disabled={saving || draft.trim().length === 0}
          icon={saving ? <Loader2 className="h-3 w-3 animate-spin" /> : undefined}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => { setDraft(description); setEditing(false) }}
          disabled={saving}
        >
          Cancel
        </Button>
        {manual && (
          <button
            type="button"
            onClick={() => save(null)}
            disabled={saving}
            className="text-xs text-primary hover:underline disabled:opacity-50 ml-auto"
          >
            Reset to auto
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Integration-level context prompt editor — admin-only. Persists via
 * PATCH /api/integrations/{id} { contextPrompt }.
 */
export function IntegrationContextPromptEditor({
  integrationId,
  initial,
}: {
  integrationId: string
  initial: string
}) {
  const { user } = useActiveUser()
  const isAdmin = user?.role === 'admin'

  if (!isAdmin) {
    return (
      <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 space-y-1">
        <div className="text-xs font-medium flex items-center gap-1.5">
          <Lock className="h-3 w-3 text-muted-foreground" />
          Context Prompt
        </div>
        <p className="text-xs text-muted-foreground">Read-only. Ask an admin to edit the per-integration context prompt.</p>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="text-xs font-medium">Context Prompt</div>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">per-integration</Badge>
      </div>
      <PromptEditor
        id="integration-context-prompt"
        value={initial}
        onSave={async (next) => {
          try {
            const res = await fetch(`/api/integrations/${integrationId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contextPrompt: next }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok || !json.ok) {
              return { ok: false, error: json?.error ?? 'Failed to save context prompt.' }
            }
            const persisted: string | undefined = json.data?.contextPrompt ?? next
            toast.success('Context prompt saved')
            return { ok: true, value: persisted }
          } catch (e) {
            return { ok: false, error: e }
          }
        }}
        maxLength={INTEGRATION_PROMPT_MAX}
        placeholder="Optional guidance injected into SQL generation for this integration. Empty injects nothing."
        helperText="Where injected: SQL synthesis + final answer prose for this integration."
      />
    </div>
  )
}
