// packages/web/src/components/desktop/constants.ts
//
// Phase C — Step 13 (§10 step 1 / §11 note 1) :
// shared MODELS / EFFORTS / PERMS constants for the desktop dialogs.
//
// These were duplicated inline in `NewOrchestratorDialog.tsx` (Step 9) and
// are re-used by `EditConfigDialog.tsx` (this step). Extracted here to
// avoid drift between the two surfaces — when the supported model list
// changes, there is one source of truth.
//
// Note: `NewOrchestratorDialog` keeps its own `MODELS` array with verbose
// labels ("Opus 4.7 (claude-opus-4-7)") because operators on the CREATE
// surface need to see the exact model id they're committing to. The
// short-label variant exported here matches the proto v2 EditConfigDialog
// (`label: m.replace('claude-', '')`).

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const PERMS = [
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const;
export type PermissionMode = (typeof PERMS)[number];

export const MODELS = [
  { value: 'claude-opus-4-7', label: 'opus-4-7' },
  { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
  { value: 'claude-haiku-4-5-20251001', label: 'haiku-4-5' },
] as const;
