import { useCallback, useEffect, useState } from 'react';
import {
  api,
  HttpError,
  type SkillActivateBody,
  type SkillActivateResult,
  type SkillAssetContent,
  type SkillReviewInfo,
} from '../../api/client';

interface Props {
  skillName: string;
  /**
   * Pre-fetched review info (e.g. from a 409 body). When null, the dialog
   * fetches it itself via GET /skills/:name/review.
   */
  review: SkillReviewInfo | null;
  open: boolean;
  onClose: () => void;
  /**
   * When provided, the dialog shows an "APPROVE & ACTIVATE" button that calls
   * activate with reviewed:true after approval.
   */
  pendingActivation?: {
    body: SkillActivateBody;
    onSuccess: (r: SkillActivateResult) => void;
  };
  /** Called after a standalone approve (no pendingActivation). */
  onApproved?: () => void;
}

function messageOf(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { last_error?: string; error?: string } | undefined;
    return body?.last_error || body?.error || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TRUST_COLOR: Record<string, string> = {
  'first-party': 'var(--ok)',
  verified: 'var(--ok)',
  community: 'var(--text-dim)',
  local: 'var(--amber)',
};

export function SkillReviewDialog({
  skillName,
  review: reviewProp,
  open,
  onClose,
  pendingActivation,
  onApproved,
}: Props) {
  const [review, setReview] = useState<SkillReviewInfo | null>(reviewProp);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchingReview, setFetchingReview] = useState(false);

  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [assetContent, setAssetContent] = useState<SkillAssetContent | null>(null);
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  // Fetch review if not provided
  const loadReview = useCallback(async () => {
    setFetchingReview(true);
    setFetchError(null);
    try {
      const r = await api.getSkillReview(skillName);
      setReview(r.review);
    } catch (e) {
      setFetchError(messageOf(e));
    } finally {
      setFetchingReview(false);
    }
  }, [skillName]);

  useEffect(() => {
    if (!open) return;
    if (reviewProp !== null) {
      setReview(reviewProp);
      return;
    }
    void loadReview();
  }, [open, reviewProp, loadReview]);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedAsset(null);
      setAssetContent(null);
      setAssetError(null);
      setOpError(null);
    }
  }, [open]);

  async function loadAsset(path: string): Promise<void> {
    setSelectedAsset(path);
    setAssetContent(null);
    setAssetError(null);
    setAssetLoading(true);
    try {
      const r = await api.getSkillAsset(skillName, path);
      setAssetContent(r.asset);
    } catch (e) {
      setAssetError(messageOf(e));
    } finally {
      setAssetLoading(false);
    }
  }

  async function doApproveAndActivate(): Promise<void> {
    if (!pendingActivation) return;
    setBusy(true);
    setOpError(null);
    try {
      const r = await api.activateSkill(skillName, {
        ...pendingActivation.body,
        reviewed: true,
      });
      pendingActivation.onSuccess(r);
      onClose();
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function doApproveOnly(): Promise<void> {
    setBusy(true);
    setOpError(null);
    try {
      await api.postSkillReview(skillName, true);
      onApproved?.();
      onClose();
    } catch (e) {
      setOpError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={`Review skill ${skillName}`}
        style={{
          background: 'var(--panel-solid, var(--panel))',
          border: '1px solid var(--border-strong, var(--border))',
          borderRadius: 8,
          padding: 24,
          width: 'min(680px, 94vw)',
          maxHeight: '88vh',
          overflowY: 'auto',
          boxShadow: '0 12px 48px rgba(0,0,0,0.55)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Header */}
        <div>
          <h3 style={{ margin: '0 0 4px', color: 'var(--amber)' }}>SKILL REVIEW — {skillName.toUpperCase()}</h3>
          <div className="field-help">
            Review the skill&apos;s assets and requirements before approving activation.
          </div>
        </div>

        {fetchingReview && <div className="field-help">Loading review info…</div>}
        {fetchError && (
          <div className="field-warn" role="alert" style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}>
            {fetchError}
          </div>
        )}

        {review && (
          <>
            {/* Trust + status summary */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span
                className="tag-pill"
                style={{
                  color: TRUST_COLOR[review.trust] ?? 'var(--text-dim)',
                  borderColor: TRUST_COLOR[review.trust] ?? 'var(--text-dim)',
                }}
              >
                {review.trust.toUpperCase()}
              </span>
              {review.reviewed ? (
                <span className="tag-pill" style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}>
                  PREVIOUSLY REVIEWED
                </span>
              ) : (
                <span className="tag-pill" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>
                  NOT YET REVIEWED
                </span>
              )}
              {review.checksum && (
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)' }}>
                  sha:{review.checksum.slice(0, 12)}
                </span>
              )}
            </div>

            {/* Warnings */}
            {review.warnings.length > 0 && (
              <div>
                <div className="field-help" style={{ marginBottom: 4, color: 'var(--amber)' }}>
                  Warnings
                </div>
                {review.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="field-warn"
                    style={{ borderLeftColor: 'var(--amber)', color: 'var(--amber)', background: 'rgba(255,180,0,0.06)', marginBottom: 4 }}
                  >
                    {w}
                  </div>
                ))}
              </div>
            )}

            {/* Plugin requirements */}
            {review.requires.plugins.length > 0 && (
              <div>
                <div className="field-help" style={{ marginBottom: 6 }}>Required plugins</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {review.pluginStatus.map((ps) => (
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
                      <span style={{ fontFamily: 'monospace' }}>{ps.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Capability requirements */}
            {review.requires.capabilities.length > 0 && (
              <div>
                <div className="field-help" style={{ marginBottom: 4 }}>Required capabilities</div>
                <div className="r-tags">
                  {review.requires.capabilities.map((cap) => (
                    <span key={cap} className="tag-pill" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>
                      {cap}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Assets */}
            {review.assets.length > 0 ? (
              <div>
                <div className="field-help" style={{ marginBottom: 6 }}>
                  Executable assets ({review.assets.length}) — click to inspect content
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {review.assets.map((a) => (
                    <button
                      key={a.path}
                      type="button"
                      className="btn"
                      style={{
                        textAlign: 'left',
                        fontFamily: 'monospace',
                        fontSize: 12,
                        padding: '4px 10px',
                        color: selectedAsset === a.path ? 'var(--amber)' : 'var(--text-dim)',
                        borderColor: selectedAsset === a.path ? 'var(--amber)' : 'var(--border)',
                        display: 'flex',
                        gap: 10,
                        alignItems: 'center',
                      }}
                      onClick={() => void loadAsset(a.path)}
                    >
                      <span style={{ flex: 1 }}>{a.path}</span>
                      <span style={{ color: 'var(--text-mute)', fontSize: 11 }}>{fmtSize(a.size)}</span>
                      {a.executable && (
                        <span className="tag-pill" style={{ color: 'var(--bad)', borderColor: 'var(--bad)', fontSize: 10 }}>
                          EXEC
                        </span>
                      )}
                      {!a.isText && (
                        <span className="tag-pill" style={{ fontSize: 10 }}>
                          BINARY
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {/* Asset content viewer */}
                {selectedAsset && (
                  <div style={{ marginTop: 10 }}>
                    <div className="field-help" style={{ marginBottom: 4 }}>
                      {selectedAsset}
                      {assetContent?.truncated && (
                        <span style={{ color: 'var(--amber)', marginLeft: 8 }}>(truncated at 256 KiB)</span>
                      )}
                    </div>
                    {assetLoading && <div className="field-help">Loading…</div>}
                    {assetError && (
                      <div className="field-warn" style={{ color: 'var(--bad)' }}>{assetError}</div>
                    )}
                    {assetContent && (
                      assetContent.binary ? (
                        <div className="field-help" style={{ color: 'var(--text-mute)' }}>
                          Binary file — content not displayed.
                        </div>
                      ) : (
                        <pre
                          style={{
                            background: 'var(--surface, rgba(0,0,0,0.3))',
                            border: '1px solid var(--border)',
                            borderRadius: 4,
                            padding: '8px 12px',
                            fontSize: 11,
                            lineHeight: 1.6,
                            overflowX: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            maxHeight: 300,
                            overflowY: 'auto',
                          }}
                        >
                          {assetContent.content || '(empty)'}
                        </pre>
                      )
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="field-help">No executable assets (instructions-only skill).</div>
            )}
          </>
        )}

        {opError && (
          <div
            className="field-warn"
            role="alert"
            style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)', background: 'rgba(224,101,74,0.06)' }}
          >
            {opError}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 4 }}>
          <button className="btn" onClick={onClose} disabled={busy}>
            CANCEL
          </button>
          {pendingActivation ? (
            <button
              className="btn"
              style={{ color: 'var(--ok)' }}
              disabled={busy || !review || fetchingReview}
              onClick={() => void doApproveAndActivate()}
            >
              {busy ? 'APPROVING…' : 'APPROVE & ACTIVATE'}
            </button>
          ) : (
            <button
              className="btn"
              style={{ color: 'var(--ok)' }}
              disabled={busy || !review || fetchingReview}
              onClick={() => void doApproveOnly()}
            >
              {busy ? 'APPROVING…' : 'APPROVE'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
