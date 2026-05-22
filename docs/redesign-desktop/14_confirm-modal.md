# Step 14 — `ConfirmModal` (Phase C.14)

> **Cible** : `packages/web/src/components/desktop/ConfirmModal.tsx`
> **Source v2** : `prototypes/v2/panels.jsx:537-557`
> **Squelette Step 2** : `docs/redesign-desktop/02_desktop-skeleton.md` §3.14
> **Câblage** : `docs/redesign-desktop/07_rightpanel-data-binding.md` §5,
>   §8 (lignes 911-986, 1196-1207), §12.5
> **Plan global** : `docs/ui-redesign-desktop.md` §5.1 step 14, §3.4 / §3.5

---

## 1. Objectif

Petit composant générique de confirmation, monté en overlay (backdrop + box
centrée) au-dessus de la `RightPanel`. Il se déclenche quand l'opérateur
clique **STOP** ou **KILL** sur un agent (lead ou worker) et garantit qu'aucune
action destructive ne part sans un second clic. Réutilisable tel quel pour
toute future action irréversible (REVOKE TOKEN, DELETE ROLE, FORCE RECONNECT,
WIPE INBOX, etc.).

Aucun appel réseau, aucun hook serveur — pure UI, état porté par le parent
qui consomme `onConfirm` / `onCancel`.

---

## 2. API

### 2.1 Props

| Prop | Type | Défaut | Rôle |
|---|---|---|---|
| `label` | `string` | _(requis)_ | Titre affiché en `.modal-title` — short caps, ex. `STOP SESSION`, `KILL SESSION`. |
| `body` | `string` | _(requis)_ | Description du risque, rendue en `.field-help` (font dim 11.5px, lineHeight 1.55). Doit nommer l'agent et le scope (lead vs worker). |
| `cls` | `'danger' \| 'primary' \| 'ghost'` | `'danger'` | Couleur du bouton CONFIRM. Mappe sur les classes existantes `.btn.danger/.primary/.ghost` (cf. design-system §1, lignes 724-824). |
| `onCancel` | `() => void` | _(requis)_ | Click backdrop, click `×`, click CANCEL, Esc. |
| `onConfirm` | `() => void` | _(requis)_ | Click CONFIRM (et Enter si non-danger — cf. §7). |

> **Note "warn" demandée par l'énoncé** : le proto v2 émet `cls: 'danger'`
> pour STOP **et** KILL (cf. `panels.jsx:213,220` et squelette Step 2 ligne
> 970,981 — `cls: 'danger'` dans les deux cas). Le design-system n'a **pas**
> de `.btn.warn` (uniquement `.primary/.ghost/.danger`). Deux options :
>
> 1. **Fidélité au proto** (recommandé v1) : on garde `cls: 'danger'` partout
>    pour KILL et STOP. Le titre et le wording distinguent déjà clairement
>    "graceful shutdown" de "hard kill". Zéro travail sur le theme.
> 2. **Distinguer visuellement STOP** : ajouter une variante `.btn.warn`
>    (border + text en `var(--warn)` ambré-orangé `#e8b04a`) dans
>    `desktop-theme.css`, puis `cls: 'warn'` pour STOP. Coût : 1 règle CSS
>    + élargir l'union du type `cls`. À reporter si on juge l'UX insuffisante.
>
> Le composant lui-même est prêt pour les deux : il accepte déjà un `cls`
> arbitraire concaténé dans `className={`btn ${cls}`}`. Si on veut autoriser
> `'warn'` plus tard, étendre simplement l'union.

### 2.2 Pattern d'utilisation

Le parent porte l'état local `confirm: ConfirmState | null`. Ouvrir =
`setConfirm({...})`, fermer = `setConfirm(null)`.

```tsx
const [confirm, setConfirm] = useState<
  { action: AgentAction; label: string; body: string; cls: 'danger' } | null
>(null);

// Ouverture
setConfirm({
  action: 'kill',
  label: 'KILL SESSION',
  body: `KILL ${selected.name} will terminate ...`,
  cls: 'danger',
});

// Rendu (au bout du JSX du parent)
{confirm && (
  <ConfirmModal
    label={confirm.label}
    body={confirm.body}
    cls={confirm.cls}
    onCancel={() => setConfirm(null)}
    onConfirm={() => {
      onAction(selected.id, confirm.action);
      setConfirm(null);
    }}
  />
)}
```

> Pattern volontairement local. On n'a pas besoin de `<ConfirmDialogProvider>`
> ni d'un store global : il n'y a **jamais** deux modales de confirmation
> simultanées (chaque RightPanel en porte une), et le coût d'un context global
> n'est pas justifié.

---

## 3. Source v2 (référence)

`prototypes/v2/panels.jsx:537-557` :

```jsx
function ConfirmModal({ label, body, cls = "danger", onCancel, onConfirm }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" style={{ width: 460 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{label}</div>
          <button className="pr-close" onClick={onCancel}>×</button>
        </div>
        <div className="modal-body">
          <div className="field-help" style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.55 }}>
            {body}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onCancel}>CANCEL</button>
          <button className={`btn ${cls}`} onClick={onConfirm}>CONFIRM</button>
        </div>
      </div>
    </div>
  );
}
```

Caractéristiques structurelles à conserver :

- Backdrop **clickable** → `onCancel` (UX standard).
- `stopPropagation` sur le contenu (`.modal`) pour éviter qu'un clic dans la
  boîte ferme la modale.
- Largeur fixe **460px** (plus étroite que le `.modal` par défaut 540px —
  c'est un dialog court).
- `.modal-head` avec titre + bouton `×` (`.pr-close`).
- `.modal-body` avec un seul paragraphe `.field-help` (dim, 11.5px,
  lineHeight 1.55) — pas de form, pas de field row.
- `.modal-foot` : CANCEL à gauche (ghost), CONFIRM à droite (`cls`).

---

## 4. JSX final TypeScript

Fichier : `packages/web/src/components/desktop/ConfirmModal.tsx`.

```tsx
// packages/web/src/components/desktop/ConfirmModal.tsx
//
// Step 14 (Phase C) — Modal générique de confirmation pour actions
// destructives. Déclenchée principalement par les boutons STOP / KILL de la
// RightPanel (cf. docs/redesign-desktop/07_rightpanel-data-binding.md §5),
// mais réutilisable pour toute future action irréversible.
//
// Pure UI : aucun appel réseau, état porté par le parent.
// Source v2 : prototypes/v2/panels.jsx:537-557.
// Squelette Step 2 : docs/redesign-desktop/02_desktop-skeleton.md §3.14.

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
```

### 4.1 Diffs vs le squelette Step 2 (`02_desktop-skeleton.md` §3.14)

Le squelette livre déjà un composant de 30 lignes correct. Step 14 ajoute :

1. **Focus initial sur CANCEL** (`useRef` + `useEffect`) — safe default.
2. **Handlers clavier** (`Escape` → cancel, `Enter` → confirm *non-danger*).
3. **Attributs ARIA** (`role="dialog"`, `aria-modal`, `aria-labelledby`,
   `aria-describedby`, `aria-label="close"` sur `×`).
4. **Type export** `ConfirmModalVariant` (utilisable côté
   `RightPanel.confirm.cls`).

Aucune autre divergence — JSX et classes CSS inchangés.

> Si une autre modale `confirm-modal-title`/`-body` est montée simultanément
> (impossible v1 — il n'y a qu'une RightPanel), on suffixerait les `id` avec
> `useId()`. Reporté.

---

## 5. Variantes (copy à figer)

Centralisé dans le helper `askConfirm` du `RightPanel` (cf. squelette Step 2
lignes 961-986). Recopié ici pour archive — **single source of truth = le
parent**, pas le composant.

| Action | Cible | `label` | `body` | `cls` |
|---|---|---|---|---|
| STOP | lead | `STOP TEAM` | `STOP {selected.name} will gracefully shut down the entire {team.name} team and its {workerCount} workers.` | `danger` (ou `warn` futur) |
| STOP | worker | `STOP WORKER` | `STOP {selected.name} will gracefully shut down this worker.` | `danger` (ou `warn` futur) |
| KILL | lead | `KILL TEAM` | `KILL {selected.name} will terminate the whole {team.name} team. All {workerCount} workers will exit immediately. This cannot be undone.` | `danger` |
| KILL | worker | `KILL WORKER` | `KILL {selected.name} will terminate this worker session. Lead will be notified.` | `danger` |

> **Note libellés** : le squelette Step 2 utilise `STOP SESSION` / `KILL
> SESSION` (générique). L'énoncé Step 14 demande `STOP TEAM` / `KILL TEAM`
> pour les leads et `STOP WORKER` / `KILL WORKER` pour les workers. **On
> retient cette dernière** — plus explicite côté opérateur, scope visible
> dès le titre. Diff à appliquer dans le `askConfirm` du parent (§6
> ci-dessous).

> **Edge case 0 worker** : si `team.workerCount === 0`, la phrase "and its
> 0 workers" est inélégante. Variante recommandée (cf. critère §6.6 dans
> `07_rightpanel-data-binding.md`) : conditionner sur `workerCount > 0` —
>
> ```ts
> body: isLead
>   ? team.workerCount > 0
>     ? `STOP ${selected.name} will gracefully shut down the entire ${team.name} team and its ${team.workerCount} ${team.workerCount === 1 ? 'worker' : 'workers'}.`
>     : `STOP ${selected.name} will gracefully shut down the ${team.name} team (no workers attached).`
>   : `STOP ${selected.name} will gracefully shut down this worker.`,
> ```

### 5.1 Réutilisations futures (catalogue)

| Surface | `label` | `body` typique | `cls` |
|---|---|---|---|
| RolesPage : delete role | `DELETE ROLE` | `Delete role {name}? Active orchestrators that reference this role will keep their snapshot but cannot be re-created with this template.` | `danger` |
| SettingsDrawer : clear token | `CLEAR AUTH TOKEN` | `Clear the saved X-Auth-Token? You will need to re-enter it to call the server.` | `danger` |
| BroadcastModal : confirm cross-team broadcast | `BROADCAST TO ALL TEAMS` | `Send "{preview}" to {N} active orchestrators?` | `primary` |
| MapView : hub-level shutdown (v2+) | `SHUTDOWN SWARM` | `Stop all {N} orchestrators? This cannot be undone.` | `danger` |

---

## 6. Câblage RightPanel

### 6.1 État local

Déjà câblé dans le squelette Step 2 (cf. `02_desktop-skeleton.md` §3.15) et
re-confirmé Step 7 (cf. `07_rightpanel-data-binding.md` lignes 911-986,
1196-1207). On garde **tel quel** :

```tsx
const [confirm, setConfirm] = useState<
  { action: AgentAction; label: string; body: string; cls: ConfirmModalVariant } | null
>(null);
```

### 6.2 Helper `askConfirm` — diff Step 14

Le helper du squelette utilisait `'KILL SESSION'` / `'STOP SESSION'`. On
adopte la nomenclature `TEAM` vs `WORKER` :

```tsx
function askConfirm(action: AgentAction) {
  if (!selected || !team) return;

  if (action === 'kill') {
    setConfirm({
      action,
      label: isLead ? 'KILL TEAM' : 'KILL WORKER',
      body: isLead
        ? `KILL ${selected.name} will terminate the whole ${team.name} team. All ${team.workerCount} workers will exit immediately. This cannot be undone.`
        : `KILL ${selected.name} will terminate this worker session. Lead will be notified.`,
      cls: 'danger',
    });
    return;
  }

  if (action === 'stop') {
    setConfirm({
      action,
      label: isLead ? 'STOP TEAM' : 'STOP WORKER',
      body: isLead
        ? `STOP ${selected.name} will gracefully shut down the entire ${team.name} team and its ${team.workerCount} workers.`
        : `STOP ${selected.name} will gracefully shut down this worker.`,
      cls: 'danger',
    });
    return;
  }

  // Toute autre action passe directement (PAUSE, RESTART, RESUME, etc.).
  onAction(selected.id, action);
}
```

### 6.3 Branchement sur les boutons (déjà câblé)

```tsx
<button className="pr-action danger" onClick={() => askConfirm('stop')}>
  {ICON.stop}<span>STOP</span>
</button>
<button className="pr-action danger" onClick={() => askConfirm('kill')}>
  {ICON.kill}<span>KILL</span>
</button>
```

### 6.4 Rendu de la modale (déjà câblé)

À la fin du `<aside className="panel-right">` :

```tsx
{confirm && (
  <ConfirmModal
    label={confirm.label}
    body={confirm.body}
    cls={confirm.cls}
    onCancel={() => setConfirm(null)}
    onConfirm={() => {
      onAction(selected.id, confirm.action);
      setConfirm(null);
    }}
  />
)}
```

### 6.5 Reset entre sessions

Le `useEffect([selected?.id])` du RightPanel reset `draft`, `composerMode`,
`audience`. **Ajouter `setConfirm(null)`** au même endroit pour qu'un switch
de session ferme automatiquement une modale orpheline :

```tsx
useEffect(() => {
  setDraft('');
  setComposerMode('pty');
  setAudience('agent');
  setConfirm(null);          // <- Step 14, défensif
}, [selected?.id]);
```

> Sans ce reset, une confirmation de KILL pour `session-A` pourrait être
> confirmée après un switch vers `session-B`, déclenchant un `onAction(B, 'kill')`
> car `selected.id` lu par le `onConfirm` est le nouvel id. Le reset coupe
> ce risque.

---

## 7. Accessibilité

| Comportement | Implémentation |
|---|---|
| **Rôle dialog modale** | `role="dialog"` + `aria-modal="true"` sur `.modal`. |
| **Titre lu par AT** | `aria-labelledby="confirm-modal-title"` → l'`id` du `<div className="modal-title">`. |
| **Description lue par AT** | `aria-describedby="confirm-modal-body"` → l'`id` du `<div className="field-help">`. |
| **Bouton ×** | `aria-label="close"` (le glyphe `×` seul est insuffisant). |
| **Focus initial** | `cancelRef.current?.focus()` au mount. **Safe default** : un screen reader / un clavier appuyant Enter immédiatement annule au lieu de confirmer. |
| **Esc → cancel** | `onKeyDown` capture `Escape` sur le `.modal-backdrop` (qui a `onKeyDown`). |
| **Enter → confirm (non-danger only)** | `onKeyDown` capture `Enter` **et** vérifie `cls !== 'danger'`. Pour les KILL/STOP, l'opérateur doit cliquer explicitement (anti-misclick claviers). |
| **Tab order** | CANCEL est avant CONFIRM dans le DOM (ghost à gauche, danger à droite) — le tab order naturel pointe d'abord vers CANCEL, conforme au focus initial. |
| **Trap focus** | _Non implémenté v1._ Acceptable car (a) la modale n'a que 3 éléments focusables (`×`, CANCEL, CONFIRM), (b) tabber sort visuellement de la modale mais Esc reste actif. Si on veut un vrai trap : ajouter `useFocusTrap` (lib externe ou hook custom) en Phase D polish. |
| **Restore focus on close** | _Non implémenté v1._ Le bouton STOP/KILL qui a ouvert la modale n'est pas re-focus après close. Acceptable car le parent dispatch `onAction` et l'agent change d'état (re-render). Phase D polish si besoin. |
| **Contraste** | `cls="danger"` utilise `var(--bad)` ; vérifier que le ratio texte/fond sur `.btn.danger` est ≥ 4.5:1 (responsabilité du design-system §1, pas du composant). |

> **Pourquoi pas trap focus v1** : zéro dépendance ajoutée, scope contrôlé
> (3 boutons), et la modale est éphémère. Le critère WCAG 2.1 SC 2.4.3 est
> respecté par le focus initial + l'Esc.

---

## 8. Plan d'implémentation pas-à-pas

1. **Vérifier le squelette Step 2** : `packages/web/src/components/desktop/ConfirmModal.tsx`
   existe-t-il déjà ? (cf. `02_desktop-skeleton.md` §3.14 — *si* Step 2 a été
   exécuté, le fichier est là). Sinon, créer le fichier vide.
2. **Écrire le composant final** (§4 ci-dessus). ~75 lignes, dont 30 reprises
   du squelette + 45 ajouts (refs, useEffect, handlers clavier, ARIA).
3. **Exporter le type** `ConfirmModalVariant` pour que `RightPanel.tsx`
   l'importe au lieu de redéfinir l'union dans son state local.
4. **Patcher `RightPanel.tsx`** (édition mineure, §6 ci-dessus) :
   - Importer `ConfirmModal` et `ConfirmModalVariant` depuis `./ConfirmModal`.
   - Remplacer le `askConfirm` du squelette pour adopter les labels
     `STOP TEAM` / `STOP WORKER` / `KILL TEAM` / `KILL WORKER`.
   - Optionnel : appliquer le fix `workerCount === 0` (§5).
   - Ajouter `setConfirm(null)` dans le `useEffect([selected?.id])` (§6.5).
5. **Smoke check** local :
   - `pnpm dev` dans `packages/web`.
   - Sélectionner un worker → cliquer STOP → vérifier titre `STOP WORKER` +
     body worker.
   - Idem KILL → vérifier titre `KILL WORKER` + body worker.
   - Sélectionner un lead → cliquer STOP → vérifier titre `STOP TEAM` + body
     team avec `workerCount`.
   - Idem KILL → vérifier titre `KILL TEAM` + body avec "cannot be undone".
   - Tester Esc, click backdrop, click ×, click CANCEL → tous ferment sans
     action.
   - Tester click CONFIRM → action dispatchée puis fermeture.
6. **Tests Vitest** (cf. §9) : créer `ConfirmModal.test.tsx`.
7. **Commit** : `Feat: ConfirmModal for STOP/KILL actions (Step 14, Phase C)`.

> **Pas de changement serveur**, pas de nouveau endpoint, pas de nouvelle
> dépendance. Le composant utilise uniquement React + types DOM standards.

---

## 9. Tests de fumée

### 9.1 Manuel (smoke en dev)

- [ ] **Worker STOP** : sélectionner un worker actif, cliquer STOP → modale
      titre `STOP WORKER`, body mentionne le nom du worker. CANCEL → modale
      ferme, worker toujours running. STOP → CONFIRM → modale ferme, status
      passe à `exited` au prochain refresh `useSession`.
- [ ] **Worker KILL** : idem mais titre `KILL WORKER` et body "will terminate
      this worker session". Bouton CONFIRM en rouge (`.btn.danger`).
- [ ] **Lead STOP** : sélectionner le lead d'une team avec ≥ 1 worker, cliquer
      STOP → modale titre `STOP TEAM`, body mentionne `entire {team.name}
      team and its N workers`. CONFIRM → `destroyOrchestrator` appelé, l'orch
      disparaît au prochain poll, RightPanel se ferme.
- [ ] **Lead KILL** : idem mais titre `KILL TEAM`, body inclut "This cannot
      be undone".
- [ ] **Backdrop click** : modale ouverte → cliquer **dans** la boîte → ne
      ferme pas (stopPropagation). Cliquer **sur** le backdrop (zone sombre
      autour) → ferme via `onCancel`.
- [ ] **Bouton `×`** : ferme la modale (équivalent CANCEL).
- [ ] **Esc** : ferme la modale (équivalent CANCEL). Vérifier que ça ne ferme
      pas aussi un overlay parent (settings drawer, broadcast modal) — le
      handler attache sur `.modal-backdrop`, pas sur `document`.
- [ ] **Enter sur danger** : modale STOP/KILL ouverte, presser Enter → ne
      confirme **pas** (anti-misclick).
- [ ] **Focus initial** : modale ouverte → presser Espace → déclenche CANCEL
      (car CANCEL est focusé par défaut).
- [ ] **Switch session pendant confirm ouvert** : ouvrir confirm KILL sur
      `session-A`, cliquer un autre node (`session-B`) dans la MapView → la
      modale doit se fermer (grâce au reset §6.5). Sinon : régression.
- [ ] **0 worker edge case** : team sans worker, STOP lead → vérifier que le
      body ne dit pas `0 workers` (si le fix §5 est appliqué).
- [ ] **A11y** : naviguer toute la modale au clavier seul (Tab) — vérifier
      qu'on passe CANCEL → CONFIRM → `×` puis retour. Lire la modale avec
      VoiceOver / NVDA : annoncer le titre puis le body.

### 9.2 Vitest unitaire (`ConfirmModal.test.tsx`)

À créer dans `packages/web/src/components/desktop/ConfirmModal.test.tsx` :

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmModal from './ConfirmModal';

describe('ConfirmModal', () => {
  const baseProps = {
    label: 'KILL WORKER',
    body: 'will terminate this worker',
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
  };

  it('renders label and body', () => {
    render(<ConfirmModal {...baseProps} />);
    expect(screen.getByText('KILL WORKER')).toBeInTheDocument();
    expect(screen.getByText(/will terminate/)).toBeInTheDocument();
  });

  it('focuses CANCEL on mount', () => {
    render(<ConfirmModal {...baseProps} />);
    expect(screen.getByText('CANCEL')).toHaveFocus();
  });

  it('calls onCancel when CANCEL clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal {...baseProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('CANCEL'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onConfirm when CONFIRM clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal {...baseProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('CONFIRM'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel on backdrop click', () => {
    const onCancel = vi.fn();
    const { container } = render(<ConfirmModal {...baseProps} onCancel={onCancel} />);
    fireEvent.click(container.querySelector('.modal-backdrop')!);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does NOT close when clicking inside the modal box', () => {
    const onCancel = vi.fn();
    const { container } = render(<ConfirmModal {...baseProps} onCancel={onCancel} />);
    fireEvent.click(container.querySelector('.modal')!);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel on Escape key', () => {
    const onCancel = vi.fn();
    const { container } = render(<ConfirmModal {...baseProps} onCancel={onCancel} />);
    fireEvent.keyDown(container.querySelector('.modal-backdrop')!, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does NOT call onConfirm on Enter when cls=danger', () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <ConfirmModal {...baseProps} cls="danger" onConfirm={onConfirm} />,
    );
    fireEvent.keyDown(container.querySelector('.modal-backdrop')!, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onConfirm on Enter when cls=primary', () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <ConfirmModal {...baseProps} cls="primary" onConfirm={onConfirm} />,
    );
    fireEvent.keyDown(container.querySelector('.modal-backdrop')!, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('applies cls to CONFIRM button', () => {
    render(<ConfirmModal {...baseProps} cls="primary" />);
    expect(screen.getByText('CONFIRM').className).toContain('primary');
  });

  it('defaults cls to danger', () => {
    render(<ConfirmModal {...baseProps} />);
    expect(screen.getByText('CONFIRM').className).toContain('danger');
  });

  it('sets aria-modal and labelledby/describedby', () => {
    render(<ConfirmModal {...baseProps} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'confirm-modal-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'confirm-modal-body');
  });
});
```

> 12 tests, durée < 200 ms, zéro dépendance MSW / network. Couvre 100% des
> branches du composant.

— FIN du document Step 14 —
