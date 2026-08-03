import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSkills } from '../hooks/useSkills';
import { useShellMode } from '../hooks/useShellMode';
import { useSwarmController } from '../controller/SwarmController';
import {
  api,
  HttpError,
  type SkillActivateBody,
  type SkillScopeActivation,
  type SkillReviewInfo,
  type SkillView,
} from '../api/client';
import { SkillImportModal } from './skills/SkillImportModal';
import { SkillReviewDialog } from './skills/SkillReviewDialog';

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

const TRUST_LABEL: Record<string, string> = {
  'first-party': 'VÉRIFIÉ',
  verified: 'VÉRIFIÉ',
  community: 'COMMUNITY',
  local: 'LOCAL',
};

function TrustBadge({ trust }: { trust: string }) {
  const label = TRUST_LABEL[trust] ?? trust.toUpperCase();
  return (
    <span
      className="tag-pill"
      style={{ color: TRUST_COLOR[trust] ?? 'var(--text-dim)', borderColor: TRUST_COLOR[trust] ?? 'var(--text-dim)' }}
    >
      {label}
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

/** Simple LCS-based line diff. Returns annotated lines. Capped at 400 lines each. */
function lineDiff(
  oldText: string,
  newText: string,
): Array<{ kind: '=' | '+' | '-'; line: string }> {
  const a = oldText.split('\n').slice(0, 400);
  const b = newText.split('\n').slice(0, 400);
  const m = a.length, n = b.length;
  // Flat row-major DP table avoids nested optional-access warnings.
  const dp = new Int32Array((m + 1) * (n + 1));
  const idx = (r: number, c: number) => r * (n + 1) + c;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const ai = a[i - 1] ?? '';
      const bj = b[j - 1] ?? '';
      dp[idx(i, j)] =
        ai === bj
          ? (dp[idx(i - 1, j - 1)] ?? 0) + 1
          : Math.max(dp[idx(i - 1, j)] ?? 0, dp[idx(i, j - 1)] ?? 0);
    }
  }
  const result: Array<{ kind: '=' | '+' | '-'; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    const ai = a[i - 1] ?? '';
    const bj = b[j - 1] ?? '';
    if (i > 0 && j > 0 && ai === bj) {
      result.unshift({ kind: '=', line: ai });
      i--; j--;
    } else if (j > 0 && (i === 0 || (dp[idx(i, j - 1)] ?? 0) >= (dp[idx(i - 1, j)] ?? 0))) {
      result.unshift({ kind: '+', line: bj });
      j--;
    } else {
      result.unshift({ kind: '-', line: ai });
      i--;
    }
  }
  return result;
}

export function SkillsPage({ open, onClose }: Props) {
  const { skills, loading, error, install, upload, upgrade, remove } = useSkills();
  const { isMobile } = useShellMode();
  const c = useSwarmController();

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [opError, setOpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [viewBody, setViewBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);

  // Upgrade diff state
  const [diffLines, setDiffLines] = useState<Array<{ kind: '=' | '+' | '-'; line: string }> | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  // Activations state
  const [activations, setActivations] = useState<SkillScopeActivation[]>([]);
  const [activationsLoading, setActivationsLoading] = useState(false);
  const [activateOrchId, setActivateOrchId] = useState<string>('');
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationMsg, setActivationMsg] = useState<string | null>(null);

  // Review dialog state (Lot 3b)
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewInfo, setReviewInfo] = useState<SkillReviewInfo | null>(null);
  const [pendingActivationBody, setPendingActivationBody] = useState<SkillActivateBody | null>(null);

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

  const loadActivations = useCallback(async (name: string) => {
    setActivationsLoading(true);
    try {
      const r = await api.getSkillActivations(name);
      setActivations(r.activations);
    } catch {
      setActivations([]);
    } finally {
      setActivationsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedName) {
      void loadActivations(selectedName);
    } else {
      setActivations([]);
    }
  }, [selectedName, loadActivations]);

  // Default the activate orch dropdown to the first running orchestrator
  useEffect(() => {
    const running = c.orchestrators.filter((o) => o.status === 'running');
    if (running.length > 0 && !activateOrchId) {
      setActivateOrchId(running[0]!.id);
    }
  }, [c.orchestrators, activateOrchId]);

  function trySelect(name: string): void {
    setSelectedName(name);
    setOpError(null);
    setViewBody(null);
    setDiffLines(null);
    setActivationMsg(null);
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
    setDiffLines(null);
    setUpgrading(true);
    setBusy(true);
    try {
      const res = await upgrade(s.name);
      // drift.previousBody is the old SKILL.md (Lot 3b enriched response)
      const previousBody = res.drift?.previousBody ?? null;
      try {
        const r = await api.getSkill(s.name);
        setViewBody(r.body);
        if (previousBody !== null) {
          setDiffLines(lineDiff(previousBody, r.body));
        }
      } catch {
        // diff unavailable; upgrade still succeeded
      }
      if (res.drift?.checksumChanged) {
        setOpError(
          'Checksum changed (assets modified) — review status was reset. Re-approve this skill before activating to resume gated activation.',
        );
      }
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBusy(false);
      setUpgrading(false);
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
      setDiffLines(null);
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function doActivate(s: SkillView): Promise<void> {
    if (!activateOrchId) return;
    setActivationBusy(true);
    setActivationMsg(null);
    const body: SkillActivateBody = { scope: 'orch', orchestratorId: activateOrchId };
    try {
      const r = await api.activateSkill(s.name, body);
      setActivationMsg(
        r.injected
          ? `Activated — injected into live sessions.`
          : 'Persisted — will apply at next spawn/resume.',
      );
      await loadActivations(s.name);
    } catch (e) {
      // 409 REVIEW_REQUIRED → open review dialog instead of showing an error
      if (e instanceof HttpError && e.status === 409) {
        const b = e.body as { code?: string; review?: SkillReviewInfo } | undefined;
        if (b?.code === 'REVIEW_REQUIRED' && b.review) {
          setReviewInfo(b.review);
          setPendingActivationBody(body);
          setReviewOpen(true);
          setActivationBusy(false);
          return;
        }
      }
      setActivationMsg(`Error: ${messageOf(e)}`);
    } finally {
      setActivationBusy(false);
    }
  }

  async function doDeactivate(s: SkillView, act: SkillScopeActivation): Promise<void> {
    setActivationBusy(true);
    setActivationMsg(null);
    try {
      await api.deactivateSkill(s.name, {
        scope: act.scope,
        orchestratorId: act.scope === 'orch' ? act.scopeId : activateOrchId,
        ...(act.scope === 'session' ? { sessionId: act.scopeId } : {}),
      });
      setActivationMsg('Deactivated — override-off persisted.');
      await loadActivations(s.name);
    } catch (e) {
      setActivationMsg(`Error: ${messageOf(e)}`);
    } finally {
      setActivationBusy(false);
    }
  }

  // Roles that include this skill
  const roleActivations = useMemo(() => {
    if (!skill) return [];
    return c.roles.filter((r) => r.skills?.some((sk) => sk.name === skill.name));
  }, [skill, c.roles]);

  const runningOrchestrators = useMemo(
    () => c.orchestrators.filter((o) => o.status === 'running'),
    [c.orchestrators],
  );

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
                {s.reviewRequired && (
                  <span className="tag-pill" style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}>
                    REVIEW REQ
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
                {skill.sourceCommit && (
                  <>
                    <span className="k">commit</span>
                    <span className="v" style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {skill.sourceCommit.slice(0, 12)}
                    </span>
                  </>
                )}
                <span className="k">assets</span>
                <span className="v">{skill.assetsPresent ? 'yes' : 'none'}</span>
                {skill.reviewRequired !== undefined && (
                  <>
                    <span className="k">review</span>
                    <span className="v">
                      {skill.reviewRequired ? (
                        skill.reviewed ? (
                          <span style={{ color: 'var(--ok)' }}>approved</span>
                        ) : (
                          <span style={{ color: 'var(--bad)' }}>required — not yet approved</span>
                        )
                      ) : (
                        <span style={{ color: 'var(--text-dim)' }}>not required</span>
                      )}
                    </span>
                  </>
                )}
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
                {skill.requires.plugins.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    {skill.pluginStatus && skill.pluginStatus.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {skill.pluginStatus.map((ps) => (
                          <div key={ps.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                            <span
                              className="tag-pill"
                              style={{
                                color: ps.installed && ps.enabled ? 'var(--ok)' : 'var(--bad)',
                                borderColor: ps.installed && ps.enabled ? 'var(--ok)' : 'var(--bad)',
                                minWidth: 64,
                                textAlign: 'center',
                              }}
                            >
                              {ps.installed ? (ps.enabled ? 'OK' : 'DISABLED') : 'MISSING'}
                            </span>
                            <span style={{ fontFamily: 'monospace' }}>{ps.name} (plugin)</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="r-tags">
                        {skill.requires.plugins.map((p) => (
                          <span key={p} className="tag-pill">{p} (plugin)</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {skill.requires.capabilities.length > 0 && (
                  <div className="r-tags">
                    {skill.requires.capabilities.map((cap) => (
                      <span key={cap} className="tag-pill" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>
                        {cap} (cap)
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Warnings (Lot 3b) */}
            {skill.warnings && skill.warnings.length > 0 && (
              <div className="role-section">
                <h3>
                  <span>WARNINGS</span>
                </h3>
                {skill.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="field-warn"
                    style={{
                      borderLeftColor: 'var(--amber)',
                      color: 'var(--amber)',
                      background: 'rgba(255,180,0,0.06)',
                      marginBottom: 6,
                    }}
                  >
                    {w}
                  </div>
                ))}
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

            {/* ── Activations panel (Lot 2b) ────────────────────────── */}
            <div className="role-section">
              <h3>
                <span>ACTIVATIONS</span>
              </h3>

              {/* Role-level activations (read-only here; managed via RoleDialog) */}
              {roleActivations.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div className="field-help" style={{ marginBottom: 4 }}>
                    Active on roles (managed via the Roles page):
                  </div>
                  <div className="r-tags">
                    {roleActivations.map((r) => (
                      <span key={r.id} className="tag-pill" style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}>
                        {r.label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Orch/session activations */}
              {activationsLoading ? (
                <div className="field-help">loading activations…</div>
              ) : activations.length === 0 ? (
                <div className="field-help">No orch/session activations.</div>
              ) : (
                <div style={{ marginBottom: 10 }}>
                  {activations.map((act) => {
                    const orch = c.orchestrators.find((o) => o.id === act.scopeId || act.scope === 'session');
                    const label = act.scope === 'orch'
                      ? (orch?.name ?? act.scopeId.slice(0, 8))
                      : act.scopeId.slice(0, 8);
                    const isNegative = act.enabled === 0;
                    return (
                      <div
                        key={`${act.scope}:${act.scopeId}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginBottom: 4,
                          fontSize: 12,
                        }}
                      >
                        <span
                          className="tag-pill"
                          style={{
                            color: isNegative ? 'var(--bad)' : 'var(--ok)',
                            borderColor: isNegative ? 'var(--bad)' : 'var(--ok)',
                          }}
                        >
                          {act.scope.toUpperCase()}
                        </span>
                        <span style={{ color: 'var(--text-dim)', fontFamily: 'monospace' }}>{label}</span>
                        {isNegative && (
                          <span style={{ color: 'var(--bad)', fontSize: 11 }}>override-off</span>
                        )}
                        <button
                          className="h-edit"
                          style={{ marginLeft: 'auto', color: 'var(--bad)', fontSize: 11 }}
                          disabled={activationBusy}
                          onClick={() => void doDeactivate(skill, act)}
                        >
                          DEACTIVATE
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Activate for a team */}
              {runningOrchestrators.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <select
                    value={activateOrchId}
                    onChange={(e) => setActivateOrchId(e.target.value)}
                    style={{ fontSize: 12, padding: '2px 6px' }}
                  >
                    {runningOrchestrators.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                  <button
                    className="btn"
                    style={{ fontSize: 11, padding: '3px 10px', color: 'var(--ok)' }}
                    disabled={activationBusy || !activateOrchId}
                    onClick={() => void doActivate(skill)}
                  >
                    ACTIVATE FOR TEAM
                  </button>
                </div>
              )}

              {activationMsg && (
                <div
                  className="field-help"
                  style={{
                    marginTop: 6,
                    color: activationMsg.startsWith('Error') ? 'var(--bad)' : 'var(--ok)',
                  }}
                >
                  {activationMsg}
                </div>
              )}
            </div>

            {/* SKILL.md body viewer */}
            {viewBody !== null && (
              <div className="role-section">
                <h3>
                  <span>SKILL.MD BODY</span>
                  <button className="h-edit" onClick={() => { setViewBody(null); setDiffLines(null); }}>
                    HIDE
                  </button>
                </h3>
                {/* Upgrade diff display */}
                {diffLines !== null ? (
                  <>
                    <div className="field-help" style={{ marginBottom: 6 }}>
                      Upgrade diff —{' '}
                      <span style={{ color: 'var(--ok)' }}>
                        +{diffLines.filter((l) => l.kind === '+').length}
                      </span>
                      {' / '}
                      <span style={{ color: 'var(--bad)' }}>
                        -{diffLines.filter((l) => l.kind === '-').length}
                      </span>
                    </div>
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
                        maxHeight: 400,
                        overflowY: 'auto',
                      }}
                    >
                      {diffLines.map((dl, idx) => (
                        <span
                          key={idx}
                          style={{
                            display: 'block',
                            color:
                              dl.kind === '+'
                                ? 'var(--ok)'
                                : dl.kind === '-'
                                ? 'var(--bad)'
                                : 'var(--text-dim)',
                            background:
                              dl.kind === '+'
                                ? 'rgba(80,200,80,0.06)'
                                : dl.kind === '-'
                                ? 'rgba(224,101,74,0.06)'
                                : 'transparent',
                          }}
                        >
                          {dl.kind === '=' ? '  ' : dl.kind === '+' ? '+ ' : '- '}
                          {dl.line}
                        </span>
                      ))}
                    </pre>
                  </>
                ) : (
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
                )}
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
                {upgrading ? 'UPGRADING…' : 'UPGRADE'}
              </button>

              {/* Review button — shown when skill has assets or review is required (Lot 3b) */}
              {(skill.assetsPresent || skill.reviewRequired) && (
                <button
                  className="btn"
                  style={{
                    color: skill.reviewRequired && !skill.reviewed ? 'var(--bad)' : 'var(--amber)',
                    borderColor: skill.reviewRequired && !skill.reviewed ? 'var(--bad)' : undefined,
                  }}
                  disabled={busy}
                  onClick={() => {
                    setReviewInfo(null);
                    setPendingActivationBody(null);
                    setReviewOpen(true);
                  }}
                  title="Review skill assets and approve"
                >
                  REVIEW
                </button>
              )}

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
          marketSearch={api.marketSearch}
          onClose={() => setImportOpen(false)}
          onImported={(r) => {
            setImportOpen(false);
            setSelectedName(r.skill.name);
            if (isMobile) setMobileView('detail');
          }}
        />
      )}

      {/* Skill review dialog — opened on 409 REVIEW_REQUIRED or from the REVIEW button */}
      {skill && (
        <SkillReviewDialog
          skillName={skill.name}
          review={reviewInfo}
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          pendingActivation={
            pendingActivationBody
              ? {
                  body: pendingActivationBody,
                  onSuccess: (r) => {
                    setActivationMsg(
                      r.injected
                        ? 'Approved & activated — injected into live sessions.'
                        : 'Approved & persisted — will apply at next spawn/resume.',
                    );
                    void loadActivations(skill.name);
                  },
                }
              : undefined
          }
          onApproved={() => {
            setActivationMsg('Approved — skill is now reviewable for activation.');
          }}
        />
      )}
    </div>
  );
}
