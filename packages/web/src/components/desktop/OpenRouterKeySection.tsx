/**
 * OPENROUTER — the API key the `opencode` agent provider spawns with.
 *
 * Mounted in `SettingsDrawer` right after AUTHENTICATION, which is the other
 * credential panel. The two are NOT the same kind of secret and the help text
 * says so: X-AUTH-TOKEN is the operator's own token and never leaves this
 * browser, this one is stored on the server (`instance_settings`) because the
 * AGENTS need it.
 *
 * Masking follows the plugin-password mechanic (`PluginConfigForm`):
 *  - the server sends the sentinel '•••' when a key is stored, never the key;
 *  - saving with the field still on the sentinel keeps the stored key, so an
 *    operator who opens the drawer to change the accent cannot wipe a
 *    credential by touching nothing;
 *  - REMOVE (or an emptied field) sends `null`, which is the only way to
 *    delete — the sentinel alone cannot express deletion.
 *
 * Why it lives in the settings row rather than an env var: this deployment runs
 * continuously and is never recreated for a config change. The key applies to
 * the NEXT spawn, and the provider's availability verdict re-evaluates on its
 * own 60 s poll — which is what the help text promises the operator.
 */
import { useEffect, useState } from 'react';
import { useInstanceSettings } from '../../hooks/useInstanceSettings';

/** Same sentinel as the server (`plugins/config-schema.ts`) and PluginConfigForm. */
const PASSWORD_SENTINEL = '•••';

const INPUT_ID = 'openrouter-api-key-input';

export function OpenRouterKeySection() {
  const { settings, setSettings } = useInstanceSettings();
  const configured = settings.openrouterApiKey !== null;
  const [value, setValue] = useState<string>(settings.openrouterApiKey ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState(false);

  // Re-sync when the server view changes (first reconcile, cross-tab storage
  // event, another panel's PATCH). Skipped while the operator is typing in it —
  // same guard as the instance-label input.
  useEffect(() => {
    if (document.activeElement?.id === INPUT_ID) return;
    setValue(settings.openrouterApiKey ?? '');
  }, [settings.openrouterApiKey]);

  const trimmed = value.trim();
  const untouched = trimmed === (settings.openrouterApiKey ?? '');

  async function commit(next: string | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await setSettings({ openrouterApiKey: next });
      setSaved(true);
      setTimeout(() => setSaved(false), 1_500);
    } catch (err) {
      // Local, not the shared hook error: a rejected key must not read as an
      // appearance failure in the panel below.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleSave(): void {
    if (untouched) return;
    // An emptied field is a deletion, not "leave it alone" — the operator wiped
    // a value they could see was there.
    void commit(trimmed.length === 0 ? null : trimmed);
  }

  function handleRemove(): void {
    setValue('');
    void commit(null);
  }

  return (
    <div className="drawer-section">
      <div className="h">OPENROUTER</div>
      <div className="field">
        <label htmlFor={INPUT_ID}>API KEY</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
          <input
            id={INPUT_ID}
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => {
              // Clear the sentinel on focus: leaving '•••' in the box invites
              // the operator to append their key to three dots.
              if (value === PASSWORD_SENTINEL) setValue('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSave();
              }
            }}
            placeholder={configured ? 'stored · type to replace' : 'sk-or-v1-…'}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn ghost"
            onClick={() => setShow((s) => !s)}
            style={{ padding: '6px 10px' }}
            aria-label={show ? 'Hide OpenRouter key' : 'Show OpenRouter key'}
          >
            {show ? 'HIDE' : 'SHOW'}
          </button>
        </div>
        <div className="field-help">
          used by <code>opencode</code> agents (models via OpenRouter) · stored
          server-side, never sent back to this page · applies to the next agent
          spawn, no restart
        </div>
      </div>

      <div className="field-help" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className={`dot ${configured ? 'ok' : 'warn'}`} />
        {configured ? 'key configured' : 'no key · opencode reads as unavailable'}
      </div>

      {error && <div className="field-warn">⚠ {error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          className="btn primary"
          onClick={handleSave}
          disabled={busy || untouched}
        >
          {/* Not plain "SAVE": the AUTHENTICATION panel above already has one,
              and two identical buttons in one drawer is an operator picking the
              wrong secret. */}
          {saved ? '✓ SAVED' : 'SAVE KEY'}
        </button>
        {configured && (
          <button
            type="button"
            className="btn ghost"
            onClick={handleRemove}
            disabled={busy}
          >
            REMOVE
          </button>
        )}
      </div>
    </div>
  );
}
