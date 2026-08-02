import { useEffect, useMemo, useState } from 'react';
import { useSkills } from '../hooks/useSkills';
import { useShellMode } from '../hooks/useShellMode';
import { api, HttpError, type SkillView } from '../api/client';
import { SkillImportModal } from './skills/SkillImportModal';

/**
 * Skills management overlay — modeled on PluginsPage / MemoryPage.
 * Lists installed skills (name, version, source, trust, assets, date),
 * with actions: import, upgrade, view body (SKILL.md), and delete.
 * Surfacing the /clear limit as required by plan §2.3.
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

const TRUST_COLOR: Record<string, string> = {
  'first-party': 'var(--ok)',
  verified: 'var(--ok)',
  community: 'var(--text-dim)',
  local: 'var(--amber)',
};

function TrustBadge({ trust }: { trust: string }) {
  return (
    <span
      className="tag-pill"
      style={{ color: TRUST_COLOR[trust] ?? 'var(--text-dim)', borderColor: TRUST_COLOR[trust] ?? 'var(--text-dim)' }}
    >
      {trust.toUpperCase()}
    </span>
  );
}

function messageOf(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { last_error?: string; error?: string } | undefined;
    return body?.last_error || body?.error || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

export function SkillsPage({ open, onClose }: Props) {
  const { skills, loading, error, install, upload, upgrade, remove } = useSkills();
  const { isMobile } = useShellMode();

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [opError, setOpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Body viewer state: null = closed, string = showing body text
  const [viewBody, setViewBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);

  useEffect(() => {
    if (open) setMobileView('list');
  }, [open]);

  useEffect(() => {
    if (selectedName == null && skills.length > 0) {
      setSelectedName(skills[0]?.name ?? null);
      return;
    }
    if (selectedName != null && !skills.find((s) => s.name === selectedName)) {
      setSelectedName(skills[0]?.name ?? null);
    }
  }, [skills, selectedName]);

  const skill = useMemo(
    () => skills.find((s) => s.name === selectedName) ?? null,
    [skills, selectedName],
  );

  function trySelect(name: string): void {
    setSelectedName(name);
    setOpError(null);
    setViewBody(null);
    if (isMobile) setMobileView('detail');
  }

  async function doViewBody(s: SkillView): Promise<void> {
    setBodyLoading(true);
    setOpError(null);
    try {
      const r = await api.getSkill(s.name);
      setViewBody(r.body);
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBodyLoading(false);
    }
  }

  async function doUpgrade(s: SkillView): Promise<void> {
    setOpError(null);
    setBusy(true);
    try {
      await upgrade(s.name);
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(s: SkillView): Promise<void> {
    if (
      !confirm(
        `Delete skill "${s.name}"?\n\nRemoves the skill from the registry. Active sessions keep the injected instructions until next /clear or restart. This cannot be undone.`,
      )
    ) {
      return;
    }
    setOpError(null);
    setBusy(true);
    try {
      await remove(s.name);
      setSelectedName(null);
      setViewBody(null);
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className={`roles-overlay${isMobile ? ` m-roles m-roles-${mobileView}` : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <aside className="roles-side">
        <div className="roles-side-head">
          <button className="back" onClick={onClose}>
            ← BACK TO MAP
          </button>
          <div className="title">SKILLS</div>
          <div className="sub">importable instruction sets — injected into agent preambles</div>
        </div>

        <div className="roles-list">
          {loading && skills.length === 0 && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              loading…
            </div>
          )}
          {error && (
            <div className="field-warn" style={{ margin: 12 }}>
              {error}
            </div>
          )}
          {!loading && !error && skills.length === 0 && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              No skills yet — import one from a folder or .tgz archive.
            </div>
          )}
          {skills.map((s) => (
            <div
              key={s.name}
              className={`role-item ${selectedName === s.name ? 'active' : ''}`}
              onClick={() => trySelect(s.name)}
            >
              <div className="r-name">{(s.displayName ?? s.name).toUpperCase()}</div>
              <div className="r-id">
                {s.name} · v{s.version}
              </div>
              <div className="r-tags">
                <TrustBadge trust={s.trust} />
                {s.assetsPresent && (
                  <span className="tag-pill" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>
                    ASSETS
                  </span>
                )}
                <span className="tag-pill">{s.sourceKind.toUpperCase()}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="roles-add">
          <button
            className="btn"
            style={{ width: '100%', color: 'var(--amber)' }}
            onClick={() => setImportOpen(true)}
            disabled={busy}
          >
            IMPORT SKILL
          </button>
        </div>
      </aside>

      <main className="roles-main">
        {isMobile && (
          <button type="button" className="m-roles-back" onClick={() => setMobileView('list')}>
            ← SKILLS
          </button>
        )}

        {skill ? (
          <>
            <h2>{(skill.displayName ?? skill.name).toUpperCase()}</h2>
            <div className="role-id">
              {skill.name} · v{skill.version} · {skill.sourceKind}
              {skill.checksum ? ` · sha256:${skill.checksum.slice(0, 8)}` : ''}
            </div>

            {skill.description && (
              <p style={{ marginTop: 8, marginBottom: 0, color: 'var(--text-dim)', fontSize: 13 }}>
                {skill.description}
              </p>
            )}

            {opError && (
              <div
                className="field-warn"
                role="alert"
                style={{
                  color: 'var(--bad)',
                  borderLeftColor: 'var(--bad)',
                  background: 'rgba(224, 101, 74, 0.06)',
                  marginBottom: 20,
                  marginTop: 16,
                }}
              >
                {opError}
              </div>
            )}

            <div className="role-section">
              <h3>
                <span>METADATA</span>
              </h3>
              <div className="cfg-kv">
                <span className="k">trust</span>
                <span className="v"><TrustBadge trust={skill.trust} /></span>
                <span className="k">source</span>
                <span className="v">
                  {skill.sourceKind}
                  {skill.sourceRef ? ` — ${skill.sourceRef}` : ''}
                </span>
                <span className="k">assets</span>
                <span className="v">{skill.assetsPresent ? 'yes' : 'none'}</span>
                <span className="k">installed</span>
                <span className="v">{fmtDate(skill.installedAt)}</span>
                <span className="k">updated</span>
                <span className="v">{fmtDate(skill.updatedAt)}</span>
                {skill.lastError && (
                  <>
                    <span className="k">last error</span>
                    <span className="v" style={{ color: 'var(--bad)' }}>
                      {skill.lastError}
                    </span>
                  </>
                )}
              </div>
            </div>

            {(skill.requires.plugins.length > 0 || skill.requires.capabilities.length > 0) && (
              <div className="role-section">
                <h3>
                  <span>REQUIRES</span>
                </h3>
                <div className="r-tags" style={{ marginBottom: 6 }}>
                  {skill.requires.plugins.map((p) => (
                    <span key={p} className="tag-pill">{p} (plugin)</span>
                  ))}
                  {skill.requires.capabilities.map((c) => (
                    <span key={c} className="tag-pill" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>
                      {c} (cap)
                    </span>
                  ))}
                </div>
              </div>
            )}

            {skill.triggers.length > 0 && (
              <div className="role-section">
                <h3>
                  <span>TRIGGERS</span>
                </h3>
                <div className="r-tags">
                  {skill.triggers.map((t) => (
                    <span key={t} className="tag-pill">{t}</span>
                  ))}
                </div>
              </div>
            )}

            {/* SKILL.md body viewer */}
            {viewBody !== null && (
              <div className="role-section">
                <h3>
                  <span>SKILL.MD BODY</span>
                  <button className="h-edit" onClick={() => setViewBody(null)}>
                    HIDE
                  </button>
                </h3>
                <pre
                  style={{
                    background: 'var(--surface, rgba(0,0,0,0.3))',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '10px 12px',
                    fontSize: 12,
                    lineHeight: 1.6,
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 320,
                    overflowY: 'auto',
                  }}
                >
                  {viewBody}
                </pre>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
              <button
                className="btn"
                onClick={() => void doViewBody(skill)}
                disabled={busy || bodyLoading}
                title="Show SKILL.md body"
              >
                {bodyLoading ? '…' : viewBody !== null ? 'REFRESH BODY' : 'VIEW BODY'}
              </button>

              <button
                className="btn"
                onClick={() => void doUpgrade(skill)}
                disabled={busy || skill.sourceKind === 'upload'}
                title={
                  skill.sourceKind === 'upload'
                    ? 'Upload-source skills require a new upload (use IMPORT)'
                    : `Re-import from ${skill.sourceKind} source`
                }
              >
                UPGRADE
              </button>

              <button className="btn danger" onClick={() => void doDelete(skill)} disabled={busy}>
                DELETE
              </button>
            </div>

            {/* §2.3 — surface the /clear limit to the operator */}
            <div
              className="field-help"
              style={{ marginTop: 20, borderLeft: '2px solid var(--amber)', paddingLeft: 10 }}
            >
              <strong style={{ color: 'var(--amber)' }}>Activation note:</strong>{' '}
              skills activated on a role take effect immediately on live sessions (hot injection via inbox), but that injection is{' '}
              <em>lost on /clear</em> — the session reverts to what was in its original preamble. Full coverage is guaranteed only at the next spawn or resume, when the preamble is rebuilt from the persisted activation.
            </div>
          </>
        ) : (
          <div className="field-help">No skill selected.</div>
        )}
      </main>

      {importOpen && (
        <SkillImportModal
          install={install}
          upload={upload}
          onClose={() => setImportOpen(false)}
          onImported={(r) => {
            setImportOpen(false);
            setSelectedName(r.skill.name);
            if (isMobile) setMobileView('detail');
          }}
        />
      )}
    </div>
  );
}
