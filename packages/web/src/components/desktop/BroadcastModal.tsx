// packages/web/src/components/desktop/BroadcastModal.tsx
//
// Phase C — Step 12 : multi-team broadcast modal.
//
// Triggered by clicking the central `SWARM // BUS` hub on the MapView. The
// proto-v2 source (`prototypes/v2/modals.jsx:429-472`) delegates the send to
// the parent ; here we keep the logic self-contained because the server
// has no `/swarm/broadcast` endpoint yet (gap §4-1 of the parent plan).
// We work around that by iterating `api.broadcastToOrchestrator(id, text)`
// over every active orchestrator in parallel via `Promise.allSettled` and
// rendering a per-team recap (success/error) inside the modal itself.
//
// Filter for "active" — `endedAt === null` AND `status in {running,
// starting}`. `'starting'` is intentionally included so an operator who
// just spun up a team can immediately broadcast to it ; the server
// mailbox is created at orchestrator instantiation (cf. spec §3.3).
//
// Reference single-team UI : `packages/web/src/components/BroadcastBar.tsx`
// (Cmd/Ctrl+Enter parity, disabled-during-send semantics).
import { useEffect, useMemo, useState } from 'react';
import { api, type OrchestratorView } from '../../api/client';

export interface BroadcastModalProps {
  open: boolean;
  onClose: () => void;
  orchestrators: readonly OrchestratorView[];
}

interface PerTeamResult {
  orchestratorId: string;
  name: string;
  ok: boolean;
  deliveredCount?: number;
  error?: string;
}

interface SendResult {
  perTeam: PerTeamResult[];
  okCount: number;
  errorCount: number;
  deliveredTotal: number;
}

function isActive(o: OrchestratorView): boolean {
  return o.endedAt === null && (o.status === 'running' || o.status === 'starting');
}

export default function BroadcastModal({ open, onClose, orchestrators }: BroadcastModalProps) {
  const [txt, setTxt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  const activeOrchestrators = useMemo(
    () => orchestrators.filter(isActive),
    [orchestrators],
  );

  // Reset state on (re)open so the next click on the hub always shows a
  // clean form (no leftover text or stale recap from a previous session).
  useEffect(() => {
    if (open) {
      setTxt('');
      setSubmitting(false);
      setResult(null);
    }
  }, [open]);

  // Esc to close — but NOT while submitting (avoid yanking the modal out
  // from under a network round-trip ; the user can still see the recap).
  useEffect(() => {
    if (!open || submitting) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const canSend =
    txt.trim().length > 0 && !submitting && activeOrchestrators.length > 0;

  async function handleSend() {
    const trimmed = txt.trim();
    if (!trimmed || submitting || activeOrchestrators.length === 0) return;
    setSubmitting(true);
    setResult(null);
    // `Promise.allSettled` (vs `Promise.all`) so a single team failure
    // doesn't discard the other results — the operator needs to know
    // exactly which teams got through and which didn't.
    const settled = await Promise.allSettled(
      activeOrchestrators.map((o) =>
        api.broadcastToOrchestrator(o.id, trimmed).then((r) => ({
          deliveredCount: r.delivered_to.length,
        })),
      ),
    );
    const perTeam: PerTeamResult[] = settled.map((s, i) => {
      const o = activeOrchestrators[i]!;
      if (s.status === 'fulfilled') {
        return {
          orchestratorId: o.id,
          name: o.name,
          ok: true,
          deliveredCount: s.value.deliveredCount,
        };
      }
      return {
        orchestratorId: o.id,
        name: o.name,
        ok: false,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      };
    });
    const okCount = perTeam.filter((p) => p.ok).length;
    setResult({
      perTeam,
      okCount,
      errorCount: perTeam.length - okCount,
      deliveredTotal: perTeam.reduce((acc, p) => acc + (p.deliveredCount ?? 0), 0),
    });
    setTxt('');
    setSubmitting(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl + Enter to send (parity with BroadcastBar.tsx:42).
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="broadcast-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title" id="broadcast-title">
            <span style={{ color: 'var(--amber)' }}>◇ BROADCAST</span>{' '}
            <span className="sub">{'// to all leads via swarm bus'}</span>
          </div>
          <button
            className="pr-close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="modal-body">
          {/* Pre-send: list of targeted teams */}
          {!result && activeOrchestrators.length > 0 && (
            <div className="field-help">
              This message is sent as <code>{"from='human'"}</code> to{' '}
              <b style={{ color: 'var(--text)' }}>{activeOrchestrators.length}</b>{' '}
              active lead{activeOrchestrators.length === 1 ? '' : 's'}:&nbsp;
              {activeOrchestrators.map((o) => o.name).join(' · ')}
            </div>
          )}

          {/* Degenerate: no active teams. Modal stays openable/closable
              but the SEND button is disabled (canSend === false). */}
          {!result && activeOrchestrators.length === 0 && (
            <div className="field-help">
              No active teams. Start one via <b>+ NEW TEAM</b> in the TopBar.
            </div>
          )}

          {/* Textarea — autofocus + Cmd/Ctrl+Enter send. Disabled while
              submitting OR when there's nothing to send to. */}
          <div className="field">
            <label htmlFor="bcast-txt">BROADCAST</label>
            <textarea
              id="bcast-txt"
              value={txt}
              onChange={(e) => setTxt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder='e.g. "Freeze all canary deploys. Audit the new router patch before resuming."'
              autoFocus
              style={{ minHeight: 110 }}
              disabled={submitting || activeOrchestrators.length === 0}
            />
            {txt.length > 500 && (
              <div className="field-help">{txt.length} chars</div>
            )}
          </div>

          {/* Post-send recap — colour-coded summary line + per-team detail.
              aria-live=polite so screen readers announce the result. */}
          {result && (
            <div className="field" aria-live="polite">
              <label>RESULT</label>
              <div
                className="field-help"
                style={{
                  color:
                    result.errorCount === 0
                      ? 'var(--ok)'
                      : result.okCount === 0
                        ? 'var(--bad)'
                        : 'var(--warn)',
                  marginBottom: 6,
                }}
              >
                {result.errorCount === 0 ? '✓ ' : result.okCount === 0 ? '✗ ' : '⚠ '}
                Reached <b>{result.okCount}</b> / {result.perTeam.length} team
                {result.perTeam.length === 1 ? '' : 's'} ·{' '}
                <b>{result.deliveredTotal}</b> session
                {result.deliveredTotal === 1 ? '' : 's'} delivered
                {result.errorCount > 0 && (
                  <>
                    {' · '}
                    <b>{result.errorCount}</b> error
                    {result.errorCount === 1 ? '' : 's'}
                  </>
                )}
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontSize: 11,
                }}
              >
                {result.perTeam.slice(0, 10).map((p) => (
                  <div
                    key={p.orchestratorId}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span className={`dot ${p.ok ? 'ok' : 'bad'}`} />
                    <span style={{ color: 'var(--text)' }}>{p.name}</span>
                    <span style={{ color: 'var(--text-mute)' }}>::</span>
                    <span style={{ color: p.ok ? 'var(--text-dim)' : 'var(--bad)' }}>
                      {p.ok ? `${p.deliveredCount} delivered` : p.error}
                    </span>
                  </div>
                ))}
                {result.perTeam.length > 10 && (
                  <div style={{ color: 'var(--text-mute)', fontSize: 10 }}>
                    + {result.perTeam.length - 10} more
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button
            className="btn ghost"
            onClick={onClose}
            disabled={submitting}
          >
            {result ? 'CLOSE' : 'CANCEL'}
          </button>
          <button
            className="btn primary"
            disabled={!canSend}
            style={{ opacity: canSend ? 1 : 0.4 }}
            onClick={() => void handleSend()}
          >
            {submitting ? 'SENDING…' : 'BROADCAST →'}
          </button>
        </div>
      </div>
    </div>
  );
}
