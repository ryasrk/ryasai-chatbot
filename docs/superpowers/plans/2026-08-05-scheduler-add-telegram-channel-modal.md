# Scheduler Add-Telegram-Channel Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create a Telegram notification channel via a nested modal pop up directly inside the Scheduler's Add Schedule dialog, without losing schedule form state.

**Architecture:** New standalone `TelegramChannelDialog` component (feature component in `src/components/`) rendered as a Radix nested dialog from `schedules-view.tsx`. Reuses the existing `POST /api/notifications` API unchanged. On success, the created channel is prepended to the schedule view's channel state and auto-selected.

**Tech Stack:** Next.js App Router, React 19, Radix UI (dialog/select), Tailwind, sonner (toast), Playwright (e2e), bun test.

**Spec:** `docs/superpowers/specs/2026-08-05-scheduler-add-telegram-channel-modal-design.md`

## Global Constraints

- Backend untouched — reuse `POST /api/notifications` exactly as-is (`{ name, type: 'telegram', config: { botToken, chatId, botUsername } }`).
- Settings view (`settings-view.tsx`) must NOT be modified.
- Modal supports **Telegram only** — no type dropdown.
- UI sizing follows the Add Schedule dialog: `max-w-md`, `text-xs` inputs, `h-8` inputs, `h-7` buttons.
- Field copy/placeholders identical to the Telegram form in `settings-view.tsx` (lines 1088-1108) so users see no behavioral difference.
- Entry points: (1) empty-state "Add channel" button, (2) a `+ Add Telegram channel` item at the bottom of the channel Select dropdown, always rendered.
- After success: modal closes, channel prepended to `notificationConfigs`, `form.notificationConfigId` auto-set to the new channel's id.
- Toast messages: success `'Notification channel saved.'`; validation `'Bot token and chat ID are required.'`; API/network failure falls back to `'Failed to save notification config.'`.
- The E2E test runs serially (playwright `workers: 1`) against the shared e2e DB — cleanup created channels in-test to avoid polluting later specs.
- Commit style: conventional commits, e.g. `feat(scheduler): ...` (see `git log`).

## File Structure

- **Create** `src/components/telegram-channel-dialog.tsx` — the modal component (form state, validation, POST, callbacks). One responsibility: create a Telegram channel via the API and report the result.
- **Create** `e2e/05-scheduler-telegram-channel.spec.ts` — e2e coverage of the flow.
- **Modify** `src/components/views/schedules-view.tsx` — wire up the dialog: state, empty-state button, dropdown item, `onCreated` handler, render at view root.

No other files change.

---

### Task 1: `TelegramChannelDialog` component

**Files:**
- Create: `src/components/telegram-channel-dialog.tsx`

**Interfaces:**
- Consumes: existing UI primitives `Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter` (`@/components/ui/dialog`), `Button, Input, Label` (`@/components/ui/button|input|label`), `toast` (`sonner`), `Loader2, Send` (`lucide-react`).
- Produces: `export function TelegramChannelDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (config: CreatedChannel) => void })` where `CreatedChannel = { id: string; name: string; type: string; isActive: boolean }`. Task 2 imports exactly this name/signature.

- [ ] **Step 1: Create the component**

```tsx
'use client'

import { useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** Shape Task 2's onCreated handler relies on — subset of the API's masked row. */
export interface CreatedChannel {
  id: string
  name: string
  type: string
  isActive: boolean
}

interface TelegramChannelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (config: CreatedChannel) => void
}

/**
 * Nested modal that creates a Telegram notification channel without leaving
 * the Add Schedule dialog. POSTs to /api/notifications and reports the new
 * channel via onCreated.
 */
export function TelegramChannelDialog({ open, onOpenChange, onCreated }: TelegramChannelDialogProps) {
  const [name, setName] = useState('')
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [botUsername, setBotUsername] = useState('')
  const [saving, setSaving] = useState(false)

  function reset() {
    setName('')
    setBotToken('')
    setChatId('')
    setBotUsername('')
  }

  async function handleSave() {
    if (!botToken.trim() || !chatId.trim()) {
      toast.error('Bot token and chat ID are required.')
      return
    }
    // Mirrors settings-view's payload: token format 123456:ABC..., chat id numeric or @channel
    const config = { botToken: botToken.trim(), chatId: chatId.trim(), botUsername: botUsername.trim() }
    const finalName = name.trim() || 'telegram config'

    setSaving(true)
    try {
      const res = await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: finalName, type: 'telegram', config }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string | { message?: string }
        config?: CreatedChannel
      }
      if (res.ok && data.ok && data.config) {
        toast.success('Notification channel saved.')
        onOpenChange(false)
        reset()
        onCreated({
          id: data.config.id,
          name: data.config.name,
          type: data.config.type,
          isActive: data.config.isActive,
        })
      } else {
        const msg = typeof data?.error === 'string' ? data.error : data?.error?.message
        toast.error(msg || 'Failed to save notification config.')
      }
    } catch {
      toast.error('Failed to save notification config.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Add Telegram Channel</DialogTitle>
          <DialogDescription className="text-xs">
            Channel for scheduled-run results. Sensitive values are AES-encrypted at rest.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Channel Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ops Alerts"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              Bot Token <span className="text-destructive">*</span>
            </Label>
            <Input
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456789:AAH... (from @BotFather)"
              className="h-8 text-xs font-mono"
            />
            <p className="text-[10px] text-muted-foreground">
              Get it from <span className="font-mono">@BotFather</span> → /newbot. Stored encrypted.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              Chat / Channel ID <span className="text-destructive">*</span>
            </Label>
            <Input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="123456789 or @mychannel"
              className="h-8 text-xs font-mono"
            />
            <p className="text-[10px] text-muted-foreground">
              For groups/channels use <span className="font-mono">@mybot</span> or message the bot once, then check{' '}
              <span className="font-mono">/getUpdates</span>.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Bot Username (optional)</Label>
            <Input
              value={botUsername}
              onChange={(e) => setBotUsername(e.target.value)}
              placeholder="@mybot or my_bot"
              className="h-8 text-xs font-mono"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="h-7 text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            onClick={handleSave}
            disabled={saving}
            className="h-7 text-xs gap-1.5"
          >
            Save Channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck` (or `bunx tsc --noEmit` if no script exists — check `package.json` scripts first)
Expected: no errors mentioning `telegram-channel-dialog.tsx`

- [ ] **Step 3: Lint**

Run: `bunx eslint src/components/telegram-channel-dialog.tsx`
Expected: no errors (warnings acceptable if pre-existing patterns produce them)

- [ ] **Step 4: Commit**

```bash
git add src/components/telegram-channel-dialog.tsx
git commit -m "feat(scheduler): add TelegramChannelDialog component for inline channel creation"
```

---

### Task 2: Wire the dialog into SchedulesView

**Files:**
- Modify: `src/components/views/schedules-view.tsx` (notification area ≈ lines 898-937, view root ≈ line 1076)

**Interfaces:**
- Consumes: `TelegramChannelDialog, type CreatedChannel` from `@/components/telegram-channel-dialog` (Task 1's exact export).
- Produces: none — final wiring.

- [ ] **Step 1: Add import and state**

In `schedules-view.tsx`, add to imports (after the view-states import, keeping alphabetical/grouped order with other `@/components` imports):

```tsx
import { TelegramChannelDialog, type CreatedChannel } from '@/components/telegram-channel-dialog'
```

Inside `SchedulesView()`, after the `integrations` state (line 213):

```tsx
const [telegramDialogOpen, setTelegramDialogOpen] = useState(false)
```

- [ ] **Step 2: Add the onCreated handler**

After `openEdit` (around line 299):

```tsx
function handleChannelCreated(config: CreatedChannel) {
  setNotificationConfigs((prev) => [config, ...prev])
  setForm((f) => ({ ...f, notificationConfigId: config.id }))
}
```

- [ ] **Step 3: Replace the empty-state button behavior**

Find the empty-state block (the `notificationConfigs.length > 0 ? (...) : (...)` ternary, lines 903-936). Replace the `onClick` of the "Add channel" button:

```tsx
<Button
  type="button"
  size="sm"
  variant="outline"
  className="h-6 shrink-0 text-[11px]"
  onClick={() => setTelegramDialogOpen(true)}
>
  Add channel
</Button>
```

(Removes the two `window.dispatchEvent` navigate-view/settings-tab lines.)

- [ ] **Step 4: Add the "+ Add Telegram channel" dropdown item**

In the Notification Channel `SelectContent` (lines 910-918), append after the mapped channel items, before `</SelectContent>`:

```tsx
<SelectSeparator />
<SelectItem
  value="__add_telegram__"
  onPointerDown={(e) => e.preventDefault()}
  onSelect={(e) => {
    e.preventDefault()
    setTelegramDialogOpen(true)
  }}
>
  <Plus className="h-3 w-3" /> Add Telegram channel
</SelectItem>
```

And add `SelectSeparator` to the existing `@/components/ui/select` import list (line 21-27). Note the leading `+` sign in the visible label comes from the `Plus` icon, keeping it consistent with the `Plus` icon used for "Add Schedule".

Wait — `SelectItem` children render inside `ItemText` via the wrapper; an icon inside children is fine (the primitive renders `{children}` inside `SelectPrimitive.ItemText`). Keep the icon.

- [ ] **Step 5: Render the modal at view root**

Just before the closing `</div>` of the outermost view container (line 1076), after the history `Dialog`:

```tsx
<TelegramChannelDialog
  open={telegramDialogOpen}
  onOpenChange={setTelegramDialogOpen}
  onCreated={handleChannelCreated}
/>
```

- [ ] **Step 6: Typecheck + lint**

Run: `bun run typecheck` && `bunx eslint src/components/views/schedules-view.tsx`
Expected: no new errors

- [ ] **Step 7: Manual smoke test (dev server)**

Run: `bun run dev` then in browser: Scheduler → Add Schedule → Notification Channel dropdown shows "+ Add Telegram channel" → opens nested modal → ESC closes only the inner modal (Add Schedule still open) → fill form → Save → modal closes, new channel auto-selected in dropdown → save schedule → verify in Settings → Notifications the channel exists.
Expected: full flow works, no lost form state.

- [ ] **Step 8: Commit**

```bash
git add src/components/views/schedules-view.tsx
git commit -m "feat(scheduler): add inline Telegram channel creation to Add Schedule dialog"
```

---

### Task 3: E2E test

**Files:**
- Create: `e2e/05-scheduler-telegram-channel.spec.ts`

**Interfaces:**
- Consumes: Playwright `test, expect, Page`; login helper pattern from `e2e/04-api-key.spec.ts` (admin@e2e.test / password123); the running dev server from `playwright.config.ts` (port 3105).
- Produces: none.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect, type Page } from '@playwright/test'

/**
 * Scheduler add-telegram-channel modal spec.
 *
 * Verifies:
 * 1. The "+ Add Telegram channel" item appears in the Add Schedule dialog's
 *    Notification Channel dropdown and opens a nested modal.
 * 2. Saving the modal creates the channel (persisted — visible in Settings →
 *    Notifications) and auto-selects it in the Add Schedule dialog.
 * 3. The Add Schedule dialog stays open with its form state intact while the
 *    nested modal is used.
 */

const E2E_EMAIL = 'admin@e2e.test'
const E2E_PASSWORD = 'password123'
const CHANNEL_NAME = 'e2e-telegram-channel'

/** Log in via API and land on the Scheduler view. */
async function loginToSchedules(page: Page) {
  await page.request.post('/api/auth/login', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  await page.goto('/?view=schedules')
  await expect(page.getByRole('button', { name: 'Add Schedule' })).toBeVisible({
    timeout: 15_000,
  })
}

test('create Telegram channel inline from Add Schedule dialog', async ({ page }) => {
  await loginToSchedules(page)

  // Clean slate: delete any leftover channel from a previous run
  const listRes = await page.request.get('/api/notifications')
  const listBody = await listRes.json()
  for (const c of listBody.configs ?? []) {
    if (c.name === CHANNEL_NAME) {
      await page.request.delete(`/api/notifications/${c.id}`)
    }
  }

  // Open Add Schedule
  await page.getByRole('button', { name: 'Add Schedule' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // Fill part of the schedule form — must survive the nested modal flow
  await page.getByPlaceholder('Daily sales summary').fill('e2e-inline-channel')

  // Open the Notification Channel dropdown and click the add item
  await page.getByRole('combobox').filter({ hasText: /No notification|channel/i }).first().click()
  await page.getByRole('option', { name: /Add Telegram channel/i }).click()

  // Nested modal is now on top
  await expect(page.getByRole('dialog', { name: /Add Telegram Channel/i })).toBeVisible()

  // Validation: save with empty fields → error toast, modal stays open
  await page.getByRole('button', { name: 'Save Channel' }).click()
  await expect(page.getByText('Bot token and chat ID are required.')).toBeVisible()

  // Fill and save
  await page.getByPlaceholder('e.g. Ops Alerts').fill(CHANNEL_NAME)
  await page.getByPlaceholder('123456789:AAH... (from @BotFather)').fill('123456789:AAEtesttoken')
  await page.getByPlaceholder('123456789 or @mychannel').fill('@e2e_test_channel')
  await page.getByRole('button', { name: 'Save Channel' }).click()

  // Modal closes; the Add Schedule dialog remains open with form state intact
  await expect(page.getByRole('dialog', { name: /Add Telegram Channel/i })).not.toBeVisible()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByPlaceholder('Daily sales summary')).toHaveValue('e2e-inline-channel')

  // New channel is auto-selected in the Notification Channel selector
  const selector = page.getByRole('combobox').filter({ hasText: new RegExp(CHANNEL_NAME, 'i') })
  await expect(selector).toBeVisible()

  // Persisted: appears via the API (same list Settings reads)
  const verify = await page.request.get('/api/notifications')
  const verifyBody = await verify.json()
  const created = (verifyBody.configs ?? []).find((c: { name: string }) => c.name === CHANNEL_NAME)
  expect(created).toBeTruthy()
  expect(created.type).toBe('telegram')
})
```

- [ ] **Step 2: Run the spec**

Run: `bun run e2e -- e2e/05-scheduler-telegram-channel.spec.ts`
Expected: PASS (1 test). If the combobox filter selector is flaky, adjust to scope by the dialog's label text ("Notification Channel") — the dialog contains exactly one channel combobox.

- [ ] **Step 3: Full e2e suite sanity (serial DB)**

Run: `bun run e2e -- e2e/01-setup-wizard.spec.ts e2e/02-auth.spec.ts e2e/05-scheduler-telegram-channel.spec.ts`
Expected: all pass — confirms the new spec doesn't break setup/auth specs via shared DB state.

- [ ] **Step 4: Commit**

```bash
git add e2e/05-scheduler-telegram-channel.spec.ts
git commit -m "test(e2e): cover inline Telegram channel creation in scheduler"
```

---

## Self-Review

**Spec coverage check:**
- Modal Telegram-only, `max-w-md`/`text-xs` styling → Task 1 code. ✓
- Empty-state button opens modal → Task 2 Step 3. ✓
- Dropdown item always rendered → Task 2 Step 4 (inside the `notificationConfigs.length > 0` branch — note: when channels exist; when none exist the empty state shows instead, per spec). ✓
- Auto-select + prepend + toast → Task 1 `handleSave` + Task 2 `handleChannelCreated`. ✓
- Error handling (validation, API, network, dismiss) → Task 1. ✓
- Nested rendering preserves schedule state → Task 2 Step 5 + asserted in Task 3. ✓
- Settings untouched; backend untouched. ✓
- E2E coverage incl. persistence across Settings/API → Task 3. ✓

**Placeholder scan:** none — all steps carry full code.

**Type consistency:** `CreatedChannel` exported from Task 1 is imported and used by Task 2 (`handleChannelCreated(config: CreatedChannel)`); Task 1's `onCreated` payload matches `maskRow` output shape (`id, name, type, isActive`). ✓
