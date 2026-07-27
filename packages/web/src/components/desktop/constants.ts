// packages/web/src/components/desktop/constants.ts
//
// OUR enumerations for the agent dialogs — effort levels and permission modes.
//
// These are swarm-os concepts (`EffortLevel` / `PermissionMode` server-side),
// not a vendor catalogue, which is why they still live in the bundle. They are
// nonetheless FILTERED PER PROVIDER at render time from
// `ProviderInfo.capabilities`: gemini has no equivalent of `--effort` at all,
// and codex has a sandbox rather than claude's permission modes. See
// `components/ProviderFields.tsx` (`effortsFor` / `permissionsFor`).
//
// Multi-provider Lot 3 — the `MODELS` array that used to live here is GONE,
// along with its three copies in `NewOrchestratorDialog`, `RoleDialog` and
// `RolesPage`. Model ids now come from `GET /providers`, whose adapters own
// their own catalogue: a list duplicated in four files was wrong in at least
// three of them, and it could only ever describe claude.

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
