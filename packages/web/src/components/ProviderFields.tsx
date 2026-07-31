// packages/web/src/components/ProviderFields.tsx
//
// Multi-provider Lot 3 — the PROVIDER and MODEL controls, shared by every
// surface that configures an agent: `NewOrchestratorDialog`, `RoleDialog`,
// `RolesPage`, and the (still disabled) `EditConfigDialog` /
// `SpawnWorkerDialog`.
//
// It exists so the four hard-coded `MODELS` arrays this lot deleted cannot grow
// back one dialog at a time. Everything here is driven by `GET /providers`.
//
// Two design rules are load-bearing and must not be "simplified" away:
//
//  1. **An unusable provider is DISABLED, never hidden.** A provider that is
//     not on PATH still appears in the list, greyed out, with the server's
//     `unavailableReason` in its `title` and a marker in its label. Hiding it
//     teaches the operator nothing; showing "`gemini` is not on PATH on the
//     host" tells them exactly what to do.
//  2. **The model catalogue is indicative, so there is always an escape
//     hatch.** The server deliberately never validates a model string — ids
//     ship faster than our releases, and rejecting a valid one is the worse
//     failure. The MODEL control therefore always offers free-text entry, and
//     always renders a current value the catalogue does not list.
//
// Styling is passed in (`className`) rather than assumed: the v2 dialogs use
// the warm-black `.field` chrome while `RoleDialog` is still Tailwind. Same
// arrangement as `DiscordOnboarding`'s `inputClassName`.

import { useEffect, useState } from 'react';
import type { ProviderInfo } from '../api/client';
import { EFFORTS, PERMS, type Effort } from './desktop/constants';

/** `<option>` value meaning "leave empty / inherit the global default". */
export const INHERIT = '';

/** `<option>` value that swaps the MODEL select for a free-text input. */
export const CUSTOM_MODEL = '__custom_model__';

/** Look up an adapter by id. `undefined` for "inherit", unknown, or not loaded yet. */
export function findProvider(
  providers: readonly ProviderInfo[],
  id: string | null | undefined,
): ProviderInfo | undefined {
  if (!id) return undefined;
  return providers.find((p) => p.id === id);
}

/**
 * The effort levels this provider can express. Empty when the adapter has no
 * equivalent of `--effort` at all (gemini) — the caller then disables the
 * control instead of pretending the value does something.
 *
 * An unknown provider (catalogue not loaded, older server) gets the full list:
 * degrading to "no controls" would be worse than degrading to "unfiltered".
 */
export function effortsFor(p: ProviderInfo | undefined): readonly Effort[] {
  if (p && !p.capabilities.effort) return [];
  return EFFORTS;
}

/**
 * The permission modes this provider accepts, in our own canonical order.
 *
 * Never returns an empty list: an adapter that declares none still runs the
 * agent SOMEHOW, and `fallbackPermissionMode` is that value. A single-entry
 * result means "not a choice" — see `isPermissionChoice`.
 */
export function permissionsFor(p: ProviderInfo | undefined): readonly string[] {
  if (!p) return PERMS;
  const allowed = new Set(p.capabilities.permissionModes);
  const known = PERMS.filter((m) => allowed.has(m));
  const extra = p.capabilities.permissionModes.filter(
    (m) => !(PERMS as readonly string[]).includes(m),
  );
  const all = [...known, ...extra];
  return all.length > 0 ? all : [p.capabilities.fallbackPermissionMode];
}

/** Is PERMISSION a real decision for this provider, or a single forced value? */
export function isPermissionChoice(p: ProviderInfo | undefined): boolean {
  return permissionsFor(p).length > 1;
}

/** Model id to use when a provider is picked and nobody named a model. */
export function defaultModelFor(p: ProviderInfo | undefined, fallback = ''): string {
  return p?.defaults.model ?? fallback;
}

/**
 * One-line explanations rendered next to a disabled control. Returning `null`
 * means "nothing worth saying" so callers can `{note && <div…>}`.
 */
export function effortNote(p: ProviderInfo | undefined): string | null {
  if (!p || p.capabilities.effort) return null;
  return `${p.label} has no reasoning-effort flag — the value is ignored.`;
}

export function permissionNote(p: ProviderInfo | undefined): string | null {
  if (!p || isPermissionChoice(p)) return null;
  return `${p.label} has no permission modes of its own — it always runs as `
    + `${p.capabilities.fallbackPermissionMode}.`;
}

/**
 * Risk 8 of the plan: an adapter without a notification hook never reports
 * `waiting`, so "agent is waiting" notifications and `compactOnWaiting` go
 * quiet. That is a documented limitation, not a bug — but it has to be SHOWN,
 * not discovered by an operator wondering why a team looks silent.
 */
export function notificationNote(p: ProviderInfo | undefined): string | null {
  if (!p || p.capabilities.notificationHook) return null;
  return `${p.label} sends no notification hook — its sessions never report `
    + `“waiting”.`;
}

/** Warn when the CURRENT selection is a provider the server cannot run. */
export function unavailableNote(
  p: ProviderInfo | undefined,
  transport: string | null,
): string | null {
  if (!p || p.available) return null;
  const reason = p.unavailableReason ?? 'no reason reported';
  const where = transport ? ` (transport: ${transport})` : '';
  return `${p.label} is not available${where}: ${reason}`;
}

/** Human label for a provider option, marking the unusable ones inline. */
export function providerOptionLabel(p: ProviderInfo): string {
  const base = p.label === p.id ? p.label : `${p.label} (${p.id})`;
  return p.available ? base : `${base} · unavailable`;
}

/** Model option label that always exposes the exact id being committed to. */
export function modelOptionLabel(m: { value: string; label: string }): string {
  return m.label.includes(m.value) ? m.label : `${m.label} (${m.value})`;
}

/**
 * Split a catalogue into `<optgroup>`s by VENDOR, or into one flat run when the
 * ids carry no vendor.
 *
 * Only opencode's ids do (`anthropic/claude-opus-5`), and only opencode needs
 * it: since the catalogue went live it offers ~200 OpenRouter slugs, and 200
 * flat `<option>`s are unusable in a native `<select>` — type-ahead there
 * matches the LABEL, which starts with the display name, so typing "qwen" jumps
 * nowhere. claude / codex / gemini have no `/` in their ids and keep exactly the
 * flat list they had; nothing about the submitted value changes either way.
 *
 * `null` as the group key means "render these ungrouped", which is what keeps
 * the three other providers byte-identical instead of wrapping them in a
 * one-group `<optgroup>` nobody asked for. Insertion order is preserved (the
 * server sorts newest-first) rather than sorted alphabetically: the first vendor
 * an operator sees should be the one that shipped most recently.
 */
export function groupModels(
  models: readonly { value: string; label: string }[],
): Array<[string | null, Array<{ value: string; label: string }>]> {
  if (!models.some((m) => m.value.includes('/'))) return [[null, [...models]]];
  const groups = new Map<string, Array<{ value: string; label: string }>>();
  const ungrouped: Array<{ value: string; label: string }> = [];
  for (const m of models) {
    const slash = m.value.indexOf('/');
    if (slash <= 0) {
      ungrouped.push(m);
      continue;
    }
    const vendor = m.value.slice(0, slash);
    const bucket = groups.get(vendor);
    if (bucket) bucket.push(m);
    else groups.set(vendor, [m]);
  }
  const out: Array<[string | null, Array<{ value: string; label: string }>]> = [];
  // Ungrouped first: a bare id in an otherwise vendored list is a hand-pinned
  // entry or an operator's own, and burying it under the vendors would hide it.
  if (ungrouped.length > 0) out.push([null, ungrouped]);
  for (const [vendor, bucket] of groups) out.push([vendor, bucket]);
  return out;
}

interface ProviderSelectProps {
  id?: string;
  /** Currently selected provider id, or `INHERIT`. */
  value: string;
  providers: readonly ProviderInfo[];
  onChange: (id: string) => void;
  className?: string;
  /** Offer an "(inherit global default)" entry — roles only. */
  inheritLabel?: string;
  disabled?: boolean;
}

/**
 * PROVIDER `<select>`. Unavailable adapters stay in the list as `disabled`
 * options carrying their reason; a value the catalogue does not describe (older
 * server, provider removed after a role was saved) is added so the control
 * never silently displays something other than the stored truth.
 */
export function ProviderSelect({
  id,
  value,
  providers,
  onChange,
  className,
  inheritLabel,
  disabled,
}: ProviderSelectProps) {
  const known = value !== INHERIT && providers.some((p) => p.id === value);
  return (
    <select
      id={id}
      className={className}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {inheritLabel !== undefined && <option value={INHERIT}>{inheritLabel}</option>}
      {value !== INHERIT && !known && (
        <option value={value}>
          {providers.length === 0 ? value : `${value} · unknown to this server`}
        </option>
      )}
      {/* A controlled <select> whose value matches no <option> silently falls
          back to the first one, so "nothing chosen yet" needs an option of its
          own — otherwise the transient render between "catalogue arrived" and
          "provider resolved" displays (and would submit) a neighbour's value. */}
      {value === INHERIT && inheritLabel === undefined && (
        <option value={INHERIT}>
          {providers.length === 0 ? '(provider catalogue unavailable)' : '(select a provider)'}
        </option>
      )}
      {providers.map((p) => (
        <option
          key={p.id}
          value={p.id}
          disabled={!p.available}
          title={p.unavailableReason ?? (p.version ? p.version : undefined)}
        >
          {providerOptionLabel(p)}
        </option>
      ))}
    </select>
  );
}

interface ModelSelectProps {
  id?: string;
  /** Current model id, or `INHERIT`. */
  value: string;
  /** The selected provider — its catalogue is the only one offered. */
  provider: ProviderInfo | undefined;
  onChange: (model: string) => void;
  className?: string;
  /** Offer an "(inherit global default)" entry — roles only. */
  inheritLabel?: string;
  /** Class for the free-text input; defaults to `className`. */
  inputClassName?: string;
}

/**
 * MODEL `<select>` limited to the selected provider's catalogue, plus a
 * free-text escape hatch. Switching to "other…" swaps in a text input; the
 * escape hatch closes again whenever the provider changes, since the point of
 * changing provider is to land on that provider's own default.
 */
export function ModelSelect({
  id,
  value,
  provider,
  onChange,
  className,
  inheritLabel,
  inputClassName,
}: ModelSelectProps) {
  const [custom, setCustom] = useState(false);
  const providerId = provider?.id ?? null;
  useEffect(() => {
    setCustom(false);
  }, [providerId]);

  const catalogue = provider?.models ?? [];
  const listed = catalogue.some((m) => m.value === value);
  const showCurrent = value !== INHERIT && !listed;

  if (custom) {
    return (
      <>
        <input
          className={inputClassName ?? className}
          value={value === INHERIT ? '' : value}
          aria-label="model id"
          placeholder="exact model id, e.g. gpt-5.2-codex"
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
        <button
          type="button"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            marginTop: 4,
            font: 'inherit',
            fontSize: 10.5,
            color: 'var(--text-mute)',
            cursor: 'pointer',
            textAlign: 'left',
          }}
          onClick={() => {
            setCustom(false);
            onChange(defaultModelFor(provider, value));
          }}
        >
          ← back to the {provider?.label ?? 'provider'} list
        </button>
      </>
    );
  }

  return (
    <select
      id={id}
      className={className}
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM_MODEL) {
          setCustom(true);
          return;
        }
        onChange(e.target.value);
      }}
    >
      {inheritLabel !== undefined && <option value={INHERIT}>{inheritLabel}</option>}
      {/* Same reason as in ProviderSelect: never let `__custom_model__` become
          the implicitly-selected first option while the catalogue is loading. */}
      {inheritLabel === undefined && value === INHERIT && (
        <option value={INHERIT}>
          {provider ? '(provider default)' : '(select a provider first)'}
        </option>
      )}
      {showCurrent && (
        <option value={value}>
          {catalogue.length > 0 ? `${value} · not in catalogue` : value}
        </option>
      )}
      {groupModels(catalogue).map(([vendor, models]) =>
        vendor === null ? (
          models.map((m) => (
            <option key={m.value} value={m.value}>
              {modelOptionLabel(m)}
            </option>
          ))
        ) : (
          <optgroup key={vendor} label={vendor}>
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {modelOptionLabel(m)}
              </option>
            ))}
          </optgroup>
        ),
      )}
      <option value={CUSTOM_MODEL}>other — type an exact id…</option>
    </select>
  );
}
