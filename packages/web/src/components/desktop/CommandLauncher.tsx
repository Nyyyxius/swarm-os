// packages/web/src/components/desktop/CommandLauncher.tsx
//
// Panneau de commandes (⌘K) — port TS de `prototypes/v2/launcher.jsx`.
// Remplace les 9 boutons de destination de la topbar : une destination
// future coûte une ligne dans LAUNCHER_GROUPS, plus un bouton de chrome.
// Cf. `docs/redesign-desktop/20_command-launcher.md`.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ICON, type IconName } from './icons';

/** Identifiants d'action — le contrat entre la table déclarative et le
 *  `switch` exhaustif de la TopBar. Ajouter un id ici casse la compilation
 *  tant que la TopBar ne le route pas (cf. `_exhaustive`). */
export type LauncherActionId =
  | 'new-team' | 'roles' | 'memory' | 'board' | 'approvals'
  | 'code-graph' | 'skills' | 'plugins' | 'ide'
  | 'update' | 'settings' | 'appearance';

export interface LauncherItem {
  id: LauncherActionId;
  label: string;
  desc: string;
  icon: IconName;
  /** teinte ambre permanente sur le label (action principale). */
  accent?: boolean;
  /** raccourci affiché à droite (indicatif — non câblé, comme le prototype). */
  kbd?: string;
  /** pastille d'état (UPDATE). */
  dot?: 'warn';
}

export interface LauncherGroup {
  label: string;
  items: readonly LauncherItem[];
}

/** Table statique — exportée pour que le test puisse vérifier que chaque
 *  `LauncherActionId` est bien atteignable depuis le panneau. */
export const LAUNCHER_GROUPS: readonly LauncherGroup[] = [
  { label: 'CREATE', items: [
    { id: 'new-team', label: 'NEW TEAM', desc: 'spin up an orchestrator + workers', icon: 'plus', accent: true, kbd: 'N' },
  ] },
  { label: 'WORKSPACE', items: [
    { id: 'roles',      label: 'ROLES',      desc: 'reusable team templates',     icon: 'template' },
    { id: 'memory',     label: 'MEMORY',     desc: 'shared long-term store',      icon: 'memory' },
    { id: 'board',      label: 'BOARD',      desc: 'task lanes across teams',     icon: 'board' },
    // Pas de compteur chiffré ici : le seul signal disponible côté client est
    // `approvalToasts`, qui repart de zéro à chaque chargement et diminue
    // quand on écarte un toast sans résoudre le gate. Un badge nourri par là
    // mentirait. À rebrancher le jour où le serveur expose un pending global.
    { id: 'approvals',  label: 'APPROVALS',  desc: 'pending human decisions',     icon: 'shield' },
    { id: 'code-graph', label: 'CODE GRAPH', desc: 'symbol + dependency map',     icon: 'graph' },
    { id: 'skills',     label: 'SKILLS',     desc: 'importable instruction sets', icon: 'inbox' },
    { id: 'plugins',    label: 'PLUGINS',    desc: 'MCP servers + connectors',    icon: 'link' },
    { id: 'ide',        label: 'IDE',        desc: 'open workspace in editor',    icon: 'code' },
  ] },
  { label: 'SYSTEM', items: [
    { id: 'settings',   label: 'SETTINGS',   desc: 'auth token · server info', icon: 'cog', kbd: ',' },
    { id: 'appearance', label: 'APPEARANCE', desc: 'backdrop + accent',        icon: 'sun' },
  ] },
];

interface Props {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPick: (id: LauncherActionId) => void;
  /** ajoute l'item UPDATE en tête du groupe SYSTEM. */
  updateAvailable?: boolean;
  /** version de la release, pour la description de l'item UPDATE. */
  updateLatest?: string | null;
  /**
   * Neutralise le raccourci d'ouverture. Vrai quand une modale est ouverte :
   * le panneau passerait AU-DESSUS d'elle (les modales sont rendues dans
   * `.app`, donc enfermées dans son contexte d'empilement — cf. le portail
   * ci-dessous), et naviguer ailleurs depuis un dialogue engagé le laisserait
   * orphelin derrière soi.
   */
  blocked?: boolean;
}

/** `true` si la frappe vient d'une zone qui consomme déjà Ctrl+K : champ de
 *  saisie, contenteditable, ou terminal xterm (Ctrl+K = kill-line readline,
 *  cf. `components/Terminal.tsx` monté par `RightPanel`). */
function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('input, textarea, [contenteditable], .xterm') !== null;
}

export default function CommandLauncher({
  open, onOpen, onClose, onPick, updateAvailable, updateLatest, blocked,
}: Props) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // UPDATE n'est pas dans la table statique : sa description dépend de la
  // version détectée, et l'item n'existe que tant qu'une release est dispo.
  const allGroups = useMemo<readonly LauncherGroup[]>(() => {
    if (!updateAvailable) return LAUNCHER_GROUPS;
    const item: LauncherItem = {
      id: 'update',
      label: 'UPDATE',
      desc: updateLatest ? `v${updateLatest} available` : 'a new version is available',
      icon: 'reload',
      dot: 'warn',
    };
    return LAUNCHER_GROUPS.map((g) =>
      g.label === 'SYSTEM' ? { ...g, items: [item, ...g.items] } : g);
  }, [updateAvailable, updateLatest]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return allGroups;
    return allGroups
      .map((g) => ({ ...g, items: g.items.filter((it) =>
        it.label.toLowerCase().includes(needle) || it.desc.toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length > 0);
  }, [q, allGroups]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => { setCursor(0); }, [q]);
  useEffect(() => {
    if (!open) return;
    setQ('');
    setCursor(0);
    // 20 ms : le panneau vient d'être monté, on laisse le layout se poser
    // avant de voler le focus (idem prototype). Timer nettoyé pour ne pas
    // toucher un input démonté si l'opérateur referme aussitôt.
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  // Écoute en phase de CAPTURE, volontairement. Huit autres composants
  // (drawer, overlays, modales) posent un handler Escape sur `window` en
  // phase de bulle ; sans arbitrage, un Escape refermerait le panneau ET la
  // couche en dessous. La capture arrive avant tout le monde : quand le
  // panneau est ouvert, il est la couche du dessus, il consomme l'Escape.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        // ⌘K (macOS) est inconditionnel — Ctrl+K n'y est pas une convention.
        // Ctrl+K, lui, est un raccourci readline VIVANT dans les terminaux
        // agents (xterm) et l'event remonte jusqu'à `window` : on ne le vole
        // que hors zone de saisie.
        if (!e.metaKey && isTypingContext(e.target)) return;
        if (!open && blocked) return;
        e.preventDefault();
        e.stopPropagation();
        if (open) onClose(); else onOpen();
      } else if (e.key === 'Escape' && open) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onOpen, onClose, blocked]);

  function onInputKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(flat.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // `noUncheckedIndexedAccess` : `flat[cursor]` est `Item | undefined`
      // (liste vide = « no match »). Le garde n'est pas cosmétique.
      const it = flat[cursor];
      if (it) onPick(it.id);
    }
  }

  if (!open) return null;

  // Index plat recalculé pendant le rendu : le curseur clavier traverse les
  // groupes, la numérotation doit donc ignorer leurs frontières.
  let idx = -1;

  // PORTAIL OBLIGATOIRE, pas une préférence de style. `.app` est en
  // `position: fixed`, ce qui crée un contexte d'empilement de niveau 0 :
  // tout z-index posé à l'intérieur y est enfermé. Or les overlays de route
  // (`.roles-overlay` & co, z-index 60) et l'IDE (80) sont rendus depuis
  // `App.tsx` EN DEHORS de `.app`, donc frères de celui-ci. Monté dans la
  // TopBar, le panneau passait sous eux quoi qu'on écrive — 91 enfermé dans 0
  // perd contre 60. Le portail le sort au niveau du body, où son z-index
  // compte enfin.
  return createPortal(
    <>
      <div className="launcher-backdrop" onClick={onClose} />
      <div className="launcher" role="dialog" aria-label="command launcher">
        <div className="launcher-search">
          {ICON.search}
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey} placeholder="jump to…" />
          <span className="launcher-kbd">esc</span>
        </div>
        <div className="launcher-body">
          {groups.length === 0 && (<div className="launcher-empty">no match</div>)}
          {groups.map((g) => (
            <div className="launcher-group" key={g.label}>
              <div className="launcher-group-h">{g.label}</div>
              {g.items.map((it) => {
                idx += 1;
                const active = idx === cursor;
                const myIdx = idx;
                // `.launcher-item` est une grille à 5 colonnes : un item ne
                // doit JAMAIS rendre plus de 5 enfants sous peine de passer à
                // la ligne. Aucun item ne porte à la fois `dot` et `kbd`.
                return (
                  <button key={it.id} type="button"
                    className={`launcher-item ${active ? 'active' : ''} ${it.accent ? 'accent' : ''}`}
                    onMouseEnter={() => setCursor(myIdx)} onClick={() => onPick(it.id)}>
                    <span className="li-icon">{ICON[it.icon]}</span>
                    <span className="li-label">{it.label}</span>
                    <span className="li-desc">{it.desc}</span>
                    {it.dot && <span className={`dot ${it.dot}`} />}
                    {it.kbd && <span className="launcher-kbd">{it.kbd}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}
