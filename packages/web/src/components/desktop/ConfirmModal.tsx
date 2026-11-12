// packages/web/src/components/desktop/ConfirmModal.tsx
//
// Step 14 (Phase C) — Modal générique de confirmation pour actions
// destructives. Déclenchée principalement par les boutons STOP / KILL de la
// RightPanel (cf. docs/internal/ui-redesign/redesign-desktop/07_rightpanel-data-binding.md §5),
// mais réutilisable pour toute future action irréversible.
//
// Pure UI : aucun appel réseau, état porté par le parent.
// Source v2 : prototypes/v2/panels.jsx:537-557.
// Squelette Step 2 : docs/internal/ui-redesign/redesign-desktop/02_desktop-skeleton.md §3.14.

import { useEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

export type ConfirmModalVariant = 'danger' | 'primary' | 'ghost';

interface Props {
  /** Titre — caps, court (ex. "KILL SESSION"). */
  label: string;
  /** Description du risque (1-3 phrases). */
  body: string;
  /** Couleur du bouton CONFIRM. Default `'danger'`. */
  cls?: ConfirmModalVariant;
  /** Esc, click backdrop, click ×, click CANCEL. */
  onCancel: () => void;
  /** Click CONFIRM (et Enter si cls !== 'danger', cf. §7). */
  onConfirm: () => void;
}

export default function ConfirmModal({
  label,
  body,
  cls = 'danger',
  onCancel,
  onConfirm,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Focus initial sur CANCEL (safe default) au prochain tick.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Esc → cancel ; Enter → confirm *uniquement si pas danger* (sinon on force
  // un clic explicite pour les actions destructives).
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key === 'Enter' && cls !== 'danger') {
      e.stopPropagation();
      onConfirm();
    }
  }

  function onBackdropClick(_e: MouseEvent<HTMLDivElement>) {
    onCancel();
  }

  function stop(e: MouseEvent<HTMLDivElement>) {
    e.stopPropagation();
  }

  return (
    <div
      className="modal-backdrop"
      onClick={onBackdropClick}
      onKeyDown={onKeyDown}
      role="presentation"
    >
      <div
        className="modal"
        style={{ width: 460 }}
        onClick={stop}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-body"
      >
        <div className="modal-head">
          <div className="modal-title" id="confirm-modal-title">{label}</div>
          <button className="pr-close" onClick={onCancel} aria-label="close">×</button>
        </div>
        <div className="modal-body">
          <div
            className="field-help"
            id="confirm-modal-body"
            style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.55 }}
          >
            {body}
          </div>
        </div>
        <div className="modal-foot">
          <button ref={cancelRef} className="btn ghost" onClick={onCancel}>CANCEL</button>
          <button className={`btn ${cls}`} onClick={onConfirm}>CONFIRM</button>
        </div>
      </div>
    </div>
  );
}
