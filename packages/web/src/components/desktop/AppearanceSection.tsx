/**
 * APPEARANCE — per-instance theme controls.
 *
 * Mounted as the last section of `SettingsDrawer`. Every change goes through
 * `useInstanceSettings().setSettings(...)`, which PATCHes the server and
 * mirrors locally (localStorage + CSS vars). On failure the hook surfaces
 * `state.error` and rolls back the visual; we display the message inline.
 *
 * The chips here are curated rather than free color pickers: any value must
 * stay legible against the warm-black background, and a flat list keeps the
 * differentiation obvious at a glance ("which color is DEV again?").
 */
import { useEffect, useState } from 'react';
import { useInstanceSettings } from '../../hooks/useInstanceSettings';
import type { InstanceBgTint, InstanceDensity } from '../../api/client';

const ACCENT_CHIPS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '#ffb060', label: 'AMBER' },
  { value: '#8ab6e0', label: 'BLUE' },
  { value: '#6ec48a', label: 'GREEN' },
  { value: '#c79afa', label: 'VIOLET' },
  { value: '#e0654a', label: 'CORAL' },
  { value: '#7fd4d0', label: 'TEAL' },
];

const BG_TINT_CHIPS: ReadonlyArray<{ value: InstanceBgTint; label: string; preview: string }> = [
  { value: 'warm', label: 'WARM', preview: '#0d0a08' },
  { value: 'neutral', label: 'NEUTRAL', preview: '#0a0a0b' },
  { value: 'cool', label: 'COOL', preview: '#080a0d' },
];

const DENSITY_CHOICES: ReadonlyArray<{ value: InstanceDensity; label: string }> = [
  { value: 'compact', label: 'COMPACT' },
  { value: 'regular', label: 'REGULAR' },
  { value: 'comfy', label: 'COMFY' },
];

const FONT_SIZE_MIN = 11;
const FONT_SIZE_MAX = 16;

export function AppearanceSection() {
  const { settings, loading, error, setSettings, resetSettings } = useInstanceSettings();
  const [label, setLabel] = useState<string>(settings.instanceLabel ?? '');
  const [resetting, setResetting] = useState(false);

  // Re-sync local label input if the settings change from elsewhere
  // (cross-tab storage event, or initial server reconcile). Skip when the
  // input is focused — the user is editing, don't overwrite mid-keystroke.
  useEffect(() => {
    if (document.activeElement?.id === 'instance-label-input') return;
    setLabel(settings.instanceLabel ?? '');
  }, [settings.instanceLabel]);

  function commitLabel(): void {
    const trimmed = label.trim();
    const next = trimmed === '' ? null : trimmed;
    if (next === settings.instanceLabel) return;
    void setSettings({ instanceLabel: next });
  }

  function pickAccent(hex: string): void {
    if (hex === settings.accent) return;
    void setSettings({ accent: hex });
  }

  function pickBgTint(tint: InstanceBgTint): void {
    if (tint === settings.bgTint) return;
    void setSettings({ bgTint: tint });
  }

  function adjustFontSize(delta: number): void {
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, settings.fontSize + delta));
    if (next === settings.fontSize) return;
    void setSettings({ fontSize: next });
  }

  function pickDensity(density: InstanceDensity): void {
    if (density === settings.density) return;
    void setSettings({ density });
  }

  async function handleReset(): Promise<void> {
    setResetting(true);
    try {
      await resetSettings();
      setLabel('');
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="drawer-section">
      <div className="h">APPEARANCE</div>

      {/* Instance label */}
      <div className="field">
        <label htmlFor="instance-label-input">INSTANCE LABEL</label>
        <input
          id="instance-label-input"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitLabel();
              (e.target as HTMLInputElement).blur();
            }
          }}
          maxLength={16}
          placeholder="optional · e.g. PROD, DEV-A, LAB"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="field-help">
          shown as a pill in the top-bar · max 16 chars · clear to remove
        </div>
      </div>

      {/* Accent chips */}
      <div className="field">
        <label>ACCENT</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {ACCENT_CHIPS.map((c) => {
            const on = c.value.toLowerCase() === settings.accent.toLowerCase();
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => pickAccent(c.value)}
                aria-label={`Accent ${c.label}`}
                aria-pressed={on}
                title={c.label}
                style={{
                  width: 32,
                  height: 22,
                  background: c.value,
                  border: on
                    ? `1.5px solid var(--text)`
                    : `1px solid var(--border)`,
                  cursor: 'pointer',
                  padding: 0,
                  borderRadius: 2,
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Background tint chips */}
      <div className="field">
        <label>BACKGROUND</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
          {BG_TINT_CHIPS.map((c) => {
            const on = c.value === settings.bgTint;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => pickBgTint(c.value)}
                aria-pressed={on}
                style={{
                  background: c.preview,
                  border: on
                    ? `1.5px solid var(--amber)`
                    : `1px solid var(--border)`,
                  color: on ? 'var(--amber)' : 'var(--text-dim)',
                  fontFamily: '"Geist Mono", monospace',
                  fontSize: 9.5,
                  letterSpacing: '0.14em',
                  padding: '6px 0',
                  cursor: 'pointer',
                  borderRadius: 2,
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Font size stepper */}
      <div className="field">
        <label>FONT SIZE</label>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            className="btn ghost"
            onClick={() => adjustFontSize(-1)}
            disabled={settings.fontSize <= FONT_SIZE_MIN}
            aria-label="Decrease font size"
            style={{ padding: '4px 12px' }}
          >
            −
          </button>
          <div
            style={{
              textAlign: 'center',
              fontFamily: '"Geist Mono", monospace',
              fontSize: 11,
              color: 'var(--text-dim)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {settings.fontSize}px
          </div>
          <button
            type="button"
            className="btn ghost"
            onClick={() => adjustFontSize(+1)}
            disabled={settings.fontSize >= FONT_SIZE_MAX}
            aria-label="Increase font size"
            style={{ padding: '4px 12px' }}
          >
            +
          </button>
        </div>
      </div>

      {/* Density radio */}
      <div className="field">
        <label>DENSITY</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
          {DENSITY_CHOICES.map((c) => {
            const on = c.value === settings.density;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => pickDensity(c.value)}
                aria-pressed={on}
                style={{
                  background: on ? 'rgba(255, 176, 96, 0.12)' : 'transparent',
                  border: on
                    ? `1.5px solid var(--amber)`
                    : `1px solid var(--border)`,
                  color: on ? 'var(--amber)' : 'var(--text-dim)',
                  fontFamily: '"Geist Mono", monospace',
                  fontSize: 9.5,
                  letterSpacing: '0.14em',
                  padding: '6px 0',
                  cursor: 'pointer',
                  borderRadius: 2,
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <div className="field-help">
          spacing presets · applied via <code>data-density</code> on
          <code> &lt;html&gt;</code>
        </div>
      </div>

      {/* Dark mode toggle — stub (UI only) */}
      <div className="field">
        <label style={{ opacity: 0.5 }}>DARK MODE</label>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            opacity: 0.5,
          }}
          title="light mode coming soon"
        >
          <input
            type="checkbox"
            checked={settings.darkMode}
            disabled
            readOnly
            aria-disabled="true"
          />
          <span className="field-help" style={{ margin: 0 }}>
            currently dark-only · light mode coming soon
          </span>
        </div>
      </div>

      {/* Error + reset */}
      {error && !loading && (
        <div className="field-warn">⚠ {error}</div>
      )}
      <div>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void handleReset()}
          disabled={resetting}
        >
          {resetting ? 'RESETTING…' : 'RESET TO DEFAULTS'}
        </button>
      </div>
    </div>
  );
}
