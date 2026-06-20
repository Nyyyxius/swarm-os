// packages/web/src/components/desktop/ConsoleOverlay.tsx
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Terminal } from '../Terminal';
import { ICON } from './icons';

/**
 * Fullscreen overlay that hosts a single agent console at maximum size, below
 * the 56px top bar (same family as RolesPage's `.roles-overlay`).
 *
 * Reusable on purpose: it owns the live `<Terminal hideChrome>` and takes the
 * input UI as `children`, so any caller (RightPanel's `Composer`, a future
 * QuickReply) slots its own composer in without this component knowing about it.
 *
 * IMPORTANT — the caller must NOT keep its own in-place `<Terminal>` mounted for
 * the same session while this overlay is open: a PTY has one writer, so a second
 * Terminal would attach as a read-only reader and the big console would ignore
 * keystrokes. The contract is "move, don't clone" — this overlay holds the only
 * live Terminal, so it owns the writer role and is fully interactive.
 */
interface Props {
  sessionId: string;
  /** Agent name (left side of the header). */
  title: ReactNode;
  /** Status chip + WRITER/READER chip, rendered next to the title. */
  headerExtra?: ReactNode;
  onClose: () => void;
  /** Forwarded to Terminal so the host can keep its WRITER/READER + log counters live. */
  onRoleChange?: (role: 'writer' | 'reader') => void;
  onDataFrame?: () => void;
  /** Input UI (e.g. Composer) rendered below the terminal. */
  children?: ReactNode;
}

export default function ConsoleOverlay({
  sessionId, title, headerExtra, onClose, onRoleChange, onDataFrame, children,
}: Props) {
  // Escape-to-close — mirrors ConfirmModal / SettingsDrawer convention.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="console-overlay" role="dialog" aria-modal="true">
      <div className="co-head">
        <div className="co-title">{title}{headerExtra}</div>
        <button className="co-close" onClick={onClose} title="collapse (Esc)">
          {ICON.collapse}<span>COLLAPSE</span>
        </button>
      </div>
      <div className="co-term">
        <Terminal
          sessionId={sessionId}
          onRoleChange={onRoleChange}
          onDataFrame={onDataFrame}
          hideChrome
        />
      </div>
      {children && <div className="co-input">{children}</div>}
    </div>
  );
}
