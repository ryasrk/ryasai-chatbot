# Add Telegram Channel Modal in Scheduler — Design

Date: 2026-08-05
Status: Approved (brainstorming complete)

## Problem

In the Scheduler view (`src/components/views/schedules-view.tsx`), the "Add Schedule" dialog lets users pick a Notification Channel. When no channels exist yet, the only option is an "Add channel" button that **navigates away** to Settings → Notifications via window events — discarding all unsaved schedule form input.

## Goal

Let users create a Telegram notification channel **without leaving the Add Schedule dialog**, via a nested modal card pop up. The new channel is saved to the same channel list used by Settings (single source of truth: `NotificationConfig` table via `GET/POST /api/notifications`).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Channel types supported in the modal | Telegram only |
| Entry points | Empty state button **and** an item inside the channel Select dropdown (always available, even when channels exist) |
| After successful creation | Modal closes; new channel auto-selected as the schedule's Notification Channel |
| Implementation approach | New standalone `TelegramChannelDialog` component (Approach A) — Settings view untouched |
| Backend | No changes — reuse `POST /api/notifications` |

## Architecture

### New component: `src/components/telegram-channel-dialog.tsx`

A feature component (lives in `components/`, not `ui/`, following the pattern of sibling feature components).

```
TelegramChannelDialog
├── props:
│   ├── open: boolean
│   ├── onOpenChange(open: boolean)
│   └── onCreated(config: { id, name, type, isActive })   // fired after successful save
├── Local form state: name, botToken, chatId, botUsername
├── Client validation: botToken & chatId required (same rules as settings-view)
├── POST /api/notifications { name, type: 'telegram', config: { botToken, chatId, botUsername } }
└── Success → onCreated(apiConfig); close; toast 'Notification channel saved.'
```

### Integration in `schedules-view.tsx`

1. **Empty state** (no channels yet): the existing "Add channel" button opens the modal instead of dispatching navigate-view/settings-tab events.
2. **Select dropdown**: a `+ Add Telegram channel` item appended at the bottom of `SelectContent`, always rendered (even with existing channels). Selecting it closes the dropdown and opens the modal. Note: needs `event.preventDefault()` on pointerdown so the outer Add Schedule dialog is not dismissed while the nested modal opens.
3. **Rendering**: the modal is rendered as a sibling at the view root (not inside the Add Schedule `DialogContent`). Radix handles nested-dialog stacking natively — the Telegram modal appears above; the Add Schedule dialog stays open behind it, preserving all schedule form state.
4. **`onCreated` handler**:
   - `setNotificationConfigs(prev => [newConfig, ...prev])` — dropdown updates instantly
   - `setForm(f => ({ ...f, notificationConfigId: newConfig.id }))` — auto-select
   - Because both Settings and the Scheduler read `GET /api/notifications`, the new channel appears in Settings → Notifications automatically on next load.

## Modal UI

Follows the Add Schedule dialog's sizing (`max-w-md`, `text-xs` inputs) for consistency.

```
┌─────────────────────────────────────┐
│ Add Telegram Channel            [X] │
│ Channel for scheduled-run results.  │
│                                     │
│ Channel Name                        │
│ [e.g. Ops Alerts          ]         │
│                                     │
│ Bot Token *                         │
│ [123456789:AAH... (from @BotFather)]│
│ Get it from @BotFather → /newbot.   │
│ Stored encrypted.                   │
│                                     │
│ Chat / Channel ID *                 │
│ [123456789 or @mychannel]           │
│ For groups/channels: message the    │
│ bot once, then check /getUpdates.   │
│                                     │
│ Bot Username (optional)             │
│ [@mybot or my_bot         ]         │
│                                     │
│              [Cancel] [Save Channel]│
└─────────────────────────────────────┘
```

Field copy/placeholders identical to the Telegram form in Settings — only the location differs.

## Data Flow

1. User clicks "+ Add Telegram channel" (dropdown item or empty-state button) → modal opens above Add Schedule.
2. Save → `POST /api/notifications` → server encrypts config (`encryptConfig`) → new `NotificationConfig` row (active).
3. API responds `{ ok: true, config: { id, name, type, isActive, ... } }`.
4. `onCreated(config)` → modal closes → config prepended to `notificationConfigs` state → auto-selected in form → toast success.
5. User saves schedule → schedule bound to new channel → scheduler worker sends run results to Telegram.

## Error Handling

- **Client validation**: bot token & chat ID required → toast error (existing pattern).
- **API failure** (400/500/network): toast error with API message; modal stays open for retry.
- **Dismiss** (ESC / overlay click / X): only the Telegram modal closes; Add Schedule remains open with form state intact.

## Testing

- **E2E (Playwright)**: open Add Schedule → open the add-channel modal from the dropdown → fill form → save → assert modal closed, new channel auto-selected in the channel selector, and the channel persisted (visible via Settings → Notifications after reload).
- **Manual check**: create channel from empty state; verify nested modal ESC only closes the inner modal; verify channel list in Settings shows the new channel.

## Out of Scope

- Email/Webhook creation in the Scheduler modal (still via Settings).
- Editing/deleting channels from the Scheduler (still via Settings).
- Any backend/API/schema changes.
