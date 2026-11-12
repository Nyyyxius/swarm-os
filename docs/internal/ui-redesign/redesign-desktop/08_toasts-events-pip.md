# Step 8 (Phase B.8) — Bind Toasts + EventsPip

> Lié au plan global `docs/internal/ui-redesign/ui-redesign-desktop.md` §3.6 (Toasts), §5.1 step 8,
> §5.2 (NotificationPanel → Toasts).
> Pré-requis : Steps 1 → 7 livrés. `Toasts.tsx` et `EventsPip.tsx` existent en
> squelette (`packages/web/src/components/desktop/`, voir
> `02_desktop-skeleton.md` §3.17 / §3.18) ; `DesktopShell.tsx` les rend déjà
> conditionnellement (`waitingToasts.length > 0 ? <Toasts/> : <EventsPip/>`).
> En Step 8 on **branche** ces composants sur `useEvents()` et on **supprime**
> `NotificationPanel.tsx` (l'ancien rendu Tailwind).

---

## 1. Objectif

Câbler les composants `Toasts` et `EventsPip` du skeleton (Step 2) sur le
hook `useEvents()` existant. Effets attendus :

1. Un `session.status_changed` avec `payload.status === 'waiting'` arrivant
   sur `/ws/events` → un toast warm-black ambré bas-droite, max 5 visibles
   + `+N older waiting →`, auto-dismiss 30 s (TTL déjà géré dans
   `useEvents`), bouton `→ OPEN` (route `#/orchestrators/<orchId>` +
   sélection du lead/de la session), bouton `×` (dismiss local).
2. Aucun toast en attente → un pip `events :: live` / `reconnecting…` bas-droite
   dérivé de `useEvents.connected`.
3. Le composant `NotificationPanel.tsx` (Tailwind, ancien style) est
   désinstallé du graphe et supprimé du disque ; tout son comportement
   passe via `Toasts.tsx` / `EventsPip.tsx`.

---

## 2. Données — formes effectives

### 2.1 `useEvents()` (déjà livré)

`packages/web/src/hooks/useEvents.ts` :

```ts
export interface WaitingNotice {
  id: string;                // dedup key (sessionId || `unknown-${ts}`)
  ts: string;                // ISO du frame `/ws/events`
  orchestratorId?: string;   // ← nécessaire pour route #/orchestrators/<id>
  sessionId?: string;        // ← nécessaire pour pré-sélection lead/worker
  reason?: string;           // payload.reason (optionnel)
}

export function useEvents(): {
  connected: boolean;             // WS open ?
  waiting: WaitingNotice[];       // toasts vivants (auto-purgés à 30 s)
  dismiss: (id: string) => void;  // efface 1 toast + cancel son timer
  clear: () => void;              // efface tous + cancel tous les timers
};
```

Points-clés (vérifiés dans le hook, lignes 66-154) :

- **Auto-dismiss** = `AUTO_DISMISS_MS = 30_000`, géré côté hook par un
  `setTimeout` par notice (Map `timersRef`). À la dismiss explicite, le timer
  est cancel pour éviter une double suppression.
- **Dedupe** par `id` (sessionId, fallback `unknown-<ts>`). Un nouveau
  waiting pour la même session retire l'ancien, push le nouveau (newer
  ts, reset du timer auto). Le tableau est **trié oldest → newest** par
  insertion.
- **Reconnect** : backoff exponentiel 1 s → 30 s, ticket WS refresh à
  chaque connect. `connected` passe à `false` dès `onclose` et `true` dès
  `onopen`.

### 2.2 Backend → frame WS

Source : `update_system.md` Phase 4 / S3 — le serveur diffuse
`{ kind: 'session.status_changed', ts, orchestratorId, sessionId, payload: { status, reason? } }`.
Le hook filtre **strictement** `kind === 'session.status_changed' && payload.status === 'waiting'`.

### 2.3 Composant cible — shape `WaitingToast` (Step 2 §3.17)

```ts
export interface WaitingToast {
  id: string;
  sessionId: string;
  teamId: string;
  teamName: string;
  agentName: string;
  reason?: string;
  at: number | string;   // ms epoch ou ISO
}
```

→ **Adapter `WaitingNotice` → `WaitingToast`** dans `DesktopShell` (cf. §7
plan). On a besoin de `teamName` et `agentName`, qui ne sont pas dans le
frame WS ; on les résout par lookup sur `orchestrators` (déjà chargé) :

| Champ `WaitingToast` | Source |
|---|---|
| `id` | `notice.id` |
| `sessionId` | `notice.sessionId ?? notice.id` |
| `teamId` | `notice.orchestratorId ?? ''` |
| `teamName` | `orchestrators.find(o => o.id === notice.orchestratorId)?.name ?? '—'` |
| `agentName` | session → `orch.sessions.find(s => s.id === notice.sessionId)?.name ?? sessionId.slice(0,8)` |
| `reason` | `notice.reason` |
| `at` | `notice.ts` (ISO — `formatRelative` accepte ISO ou number) |

Si le lookup échoue (orch pas encore arrivé via le poll 3 s), on dégrade :
`teamName = '—'`, `agentName = sessionId.slice(0,8)`. Le toast reste visible.

---

## 3. `Toasts.tsx` — fichier final (déjà OK depuis Step 2)

Le squelette créé en Step 2 (`02_desktop-skeleton.md` §3.17) **n'a pas
besoin de modification** en Step 8 — c'est un composant présentational pur,
sa logique de stacking + overflow + boutons est conforme au proto v2. On
relit pour mémoire :

```tsx
// packages/web/src/components/desktop/Toasts.tsx
import { formatRelative } from '../../lib/format';

const TOAST_MAX_VISIBLE = 5;

export interface WaitingToast {
  id: string;
  sessionId: string;
  teamId: string;
  teamName: string;
  agentName: string;
  reason?: string;
  at: number | string;
}

interface Props {
  items: readonly WaitingToast[];
  onOpen: (t: WaitingToast) => void;
  onDismiss: (id: string) => void;
}

export default function Toasts({ items, onOpen, onDismiss }: Props) {
  const visible = items.slice(0, TOAST_MAX_VISIBLE);
  const olderCount = items.length - visible.length;
  const firstOlder = items[TOAST_MAX_VISIBLE];

  return (
    <div className="toasts">
      {olderCount > 0 && firstOlder && (
        <div className="toasts-older" onClick={() => onOpen(firstOlder)}>
          + {olderCount} older waiting →
        </div>
      )}
      {visible.map((t) => (
        <div className="toast" key={t.id}>
          <div className="t-head">
            <span className="t-title">SESSION WAITING</span>
            <span className="t-time">{formatRelative(t.at)}</span>
          </div>
          <div className="t-id">{t.teamName} :: {t.agentName}</div>
          {t.reason && <div className="t-reason">{t.reason}</div>}
          <div className="t-foot">
            <span style={{
              fontFamily: 'Geist Mono, monospace',
              fontSize: 9, letterSpacing: '0.14em',
              color: 'var(--text-mute)',
            }}>
              {t.sessionId}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="dismiss" onClick={() => onDismiss(t.id)} title="dismiss">×</button>
              <button className="open" onClick={() => onOpen(t)}>→ OPEN</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
```

### 3.1 Notes sur le rendu

- **Ordre** : le proto pass `items` du plus récent au plus ancien (le hook
  trie oldest → newest). Pour rester fidèle au proto v2 (« most-recent first ;
  the column is reversed so visually top = oldest, bottom = newest »), on
  passe `[...waiting].reverse()` au composant côté `DesktopShell` (cf. §7).
  Le composant lui-même ne re-trie pas — il consomme l'ordre reçu.
- **Stacking max 5** : `items.slice(0, 5)`. Au-delà : ligne
  `+N older waiting →` cliquable (alias `onOpen(items[5])` → ouvre le
  6e plus récent). Cohérent avec `v2/toasts.jsx:18-22`.
- **`+N older`** : le proto v2 fait `onOpen(items[TOAST_MAX_VISIBLE])`.
  C'est intentionnel : cliquer sur "+N older" navigue vers la session
  juste au-delà du cap visible, pas vers une vue liste. À conserver tel
  quel (pas de modal "all waiting").
- **`onDismiss(t.id)`** : appelle `useEvents.dismiss(id)` dans
  `DesktopShell`. Le hook cancel le timer + retire la notice.
- **`onOpen(t)`** : navigue (cf. §7) — set `selectedSessionId` + sync route.
  ⚠ **N'appelle PAS `dismiss`** automatiquement — c'est le comportement du
  proto v2 (l'utilisateur peut laisser le toast visible après avoir ouvert
  la session). Si on veut auto-dismiss à l'ouverture, l'ajouter dans le
  handler de `DesktopShell` (recommandation = OUI, dismiss après open ;
  c'est le comportement de l'actuel `NotificationPanel` implicitement via
  navigation hors-toast).
- **CSS** : toutes les classes (`.toasts`, `.toast`, `.toasts-older`,
  `.t-head`, `.t-title`, `.t-time`, `.t-id`, `.t-reason`, `.t-foot`,
  `.dismiss`, `.open`) doivent être présentes dans `desktop-theme.css`
  livré au Step 1. **Vérifier** au moment de l'implémentation que ces
  classes existent (les noms sont attendus identiques au prototype v2).

---

## 4. `EventsPip.tsx` — fichier final (déjà OK depuis Step 2)

Identique au squelette Step 2 (`02_desktop-skeleton.md` §3.18). Aucune
modification en Step 8 :

```tsx
// packages/web/src/components/desktop/EventsPip.tsx

interface Props {
  connected: boolean;
}

export default function EventsPip({ connected }: Props) {
  return (
    <div className="events-pip">
      <span className={`dot ${connected ? 'ok' : 'warn'}`} />
      events :: {connected ? 'live' : 'reconnecting…'}
    </div>
  );
}
```

### 4.1 Notes sur le rendu

- Affiché **uniquement** quand `waiting.length === 0` (logique de toggle
  dans `DesktopShell`, ne pas le rendre en parallèle des toasts).
- CSS `.events-pip` + `.dot.ok` / `.dot.warn` doivent exister dans
  `desktop-theme.css` (livrés Step 1).
- Pas de `setInterval` interne : c'est un rendu purement réactif à la
  prop `connected`. Le re-render vient du `setConnected(true|false)` du
  hook.

---

## 5. Auto-dismiss — qui gère quoi ?

| Aspect | Géré côté |
|---|---|
| `TOAST_TTL_MS = 30 000` (constante) | Hook `useEvents` (`AUTO_DISMISS_MS`, ligne 33) |
| Timer par notice | Hook (`timersRef: Map<id, timeout>`, lignes 45 + 72-80) |
| Cancel timer si dismiss explicite | Hook (`cancelTimer(id)` ligne 47) |
| Cancel timer si reset session (nouveau waiting) | Hook (lignes 73-74 : `existing = timers.get(id); if (existing) clearTimeout(existing)`) puis re-schedule |
| Cleanup à unmount | Hook (lignes 143-152) |
| Retrait visuel post-TTL | Hook → `setWaiting(w => filter)` ligne 76 → re-render `DesktopShell` → re-render `Toasts` |
| Animation fade-out | **Pas implémentée** dans le proto v2 (toast disparaît brutalement). CSS du Step 1 peut ajouter `transition` si souhaité, mais pas requis v1. |

⇒ **Le composant `Toasts.tsx` ne gère AUCUN timer.** Il est purement
contrôlé. Toute la mécanique TTL est confinée dans `useEvents`.

⚠ **Constante `TOAST_TTL_MS`** : le proto v2 expose `window.TOAST_TTL_MS = 30000`
(toasts.jsx:7+59). Dans notre code TS, la constante équivalente est
`AUTO_DISMISS_MS` (en privé dans `useEvents.ts`). Si Step 8 veut **exporter**
cette constante (par cohérence avec le doc plan §3.6 qui la cite explicitement
`TOAST_TTL_MS = 30000`), ajouter à `useEvents.ts` :

```ts
export const TOAST_TTL_MS = 30_000;
// renommer la constante interne :
const AUTO_DISMISS_MS = TOAST_TTL_MS;
```

→ Pas obligatoire pour la fonctionnalité. À faire seulement si on veut
référencer la valeur depuis un test ou un dialog "auto-dismiss in 30s".
**Recommandation** : faire le rename par cohérence sémantique avec le proto
(une seule constante nommée explicitement, exportée).

---

## 6. Suppression `NotificationPanel.tsx`

### 6.1 Où il est monté

Un seul site d'instanciation, dans `packages/web/src/App.tsx` :

- **Import** ligne 4 : `import { NotificationPanel } from './components/NotificationPanel';`
- **Rendu** lignes 196-199 :

```tsx
<NotificationPanel
  onOpenOrchestrator={(id) => setRoute({ kind: 'detail', id })}
/>
```

Aucune autre référence (vérifié par `grep -rn "NotificationPanel"
packages/web/src/`).

Aucun test ne monte `NotificationPanel` (`find packages/web -name "*.test.*"`
+ `grep NotificationPanel` → 0 résultat).

### 6.2 Comment le retirer proprement

1. Dans `App.tsx` :
   - **Supprimer** l'import ligne 4.
   - **Supprimer** le bloc `<NotificationPanel ... />` lignes 196-199.

   Diff minimal :
   ```diff
   - import { NotificationPanel } from './components/NotificationPanel';
   …
   -       <NotificationPanel
   -         onOpenOrchestrator={(id) => setRoute({ kind: 'detail', id })}
   -       />
   ```

   La navigation `id → #/orchestrators/<id>` est désormais portée par
   `DesktopShell` (via `onOpenOrchestrator` prop reçu de `App.tsx`,
   cf. Step 3 §6.2.4) — le hook `useEvents` est appelé **dans
   `DesktopShell`** et son `onOpen` invoque le même `setRoute({ kind: 'detail', id })`.

2. Supprimer le fichier source :
   ```bash
   git rm packages/web/src/components/NotificationPanel.tsx
   ```

3. **Vérification finale** :
   ```bash
   grep -rn "NotificationPanel" packages/web/src/   # doit retourner 0
   ```

### 6.3 Risque de régression — points à valider

- ❗ **Double-mount de `useEvents`** : `useEvents` crée une connexion WS.
  Si on laissait à la fois `NotificationPanel` (qui appelle `useEvents`)
  ET `DesktopShell` (qui l'appellera aussi en Step 8), on aurait **2
  connexions WS parallèles**. C'est le bug qui a été fixé dans le commit
  `584d9ec` (« Fix: events WS loop spawning duplicate connections »).
  → La suppression de `NotificationPanel` **doit être faite dans le même
  commit/PR** que le câblage de `useEvents` dans `DesktopShell`.
- ❗ **Pas de hook entre temps** : le hook est appelé exactement une fois,
  au niveau `DesktopShell` (qui est monté pour `route.kind === 'list'` ET
  `route.kind === 'detail'`). Pour `route.kind === 'roles'`,
  `DesktopShell` est toujours rendu en arrière-plan (cf. Step 3 §3.1
  table), donc `useEvents` continue de tourner — comportement conservé.

---

## 7. Plan d'implémentation pas-à-pas

### 7.1 Pré-requis

- Steps 1-7 livrés.
- `DesktopShell.tsx` existe (§6.1 Step 3) ET importe déjà `useOrchestrators`.
- `Toasts.tsx` + `EventsPip.tsx` skeletons présents dans `desktop/`.
- `useEvents.ts` existe sans modification structurelle (just rename de
  constante optionnel, cf. §5).

### 7.2 Modifications dans `DesktopShell.tsx`

#### 7.2.1 Imports à ajouter

```ts
import { useEvents } from '../../hooks/useEvents';
import Toasts, { type WaitingToast } from './Toasts';
import EventsPip from './EventsPip';
// (orchestrators déjà importé via useOrchestrators)
```

(Les imports `Toasts` / `EventsPip` existent peut-être déjà depuis Step 2 —
les laisser).

#### 7.2.2 Hooks dans le corps du composant

À ajouter dans `DesktopShell()` (à côté des autres hooks `useOrchestrators`
/ `useState` lift `selectedSessionId`) :

```ts
const { waiting, dismiss, connected } = useEvents();
// `clear` non utilisé : le proto v2 n'a pas de bouton "clear all".
```

#### 7.2.3 Adapter `WaitingNotice[]` → `WaitingToast[]`

À ajouter dans `DesktopShell` (memoized, depuis `orchestrators` + `waiting`) :

```ts
const waitingToasts = useMemo<WaitingToast[]>(
  () => {
    // waiting est oldest → newest dans le hook.
    // Le composant Toasts attend newest → oldest (most-recent en haut visuel).
    const reversed = [...waiting].reverse();
    return reversed.map<WaitingToast>((n) => {
      const orch = n.orchestratorId
        ? orchestrators.find((o) => o.id === n.orchestratorId)
        : undefined;
      const session = orch && n.sessionId
        ? orch.sessions.find((s) => s.id === n.sessionId)
        : undefined;
      return {
        id: n.id,
        sessionId: n.sessionId ?? n.id,
        teamId: n.orchestratorId ?? '',
        teamName: orch?.name ?? '—',
        agentName: session?.name ?? (n.sessionId ? n.sessionId.slice(0, 8) : '—'),
        reason: n.reason,
        at: n.ts,
      };
    });
  },
  [waiting, orchestrators],
);
```

#### 7.2.4 Handler `onOpen`

`onOpen(toast)` doit :

1. Pré-sélectionner la session correcte (`setSelectedSessionId(toast.sessionId)`).
2. Synchroniser la route via le callback parent
   `onOpenOrchestrator(toast.teamId)` (cf. Step 3 §6.1) — sans ce call,
   le hash reste sur `#/` même si le RightPanel s'ouvre.
3. Optionnel mais recommandé : `dismiss(toast.id)` pour retirer le toast
   après ouverture.

```ts
function handleToastOpen(t: WaitingToast) {
  if (t.sessionId) setSelectedSessionId(t.sessionId);
  if (t.teamId)    onOpenOrchestrator(t.teamId);
  dismiss(t.id);    // ← retirer le toast après navigation
}
```

⚠ **Edge case** : `t.teamId === ''` (orchestratorId absent du frame WS).
Dans ce cas on **n'appelle pas** `onOpenOrchestrator('')`. La sélection de
la session via `setSelectedSessionId` reste utile, mais sans route sync
(le hash restera sur `#/`).

#### 7.2.5 JSX final (zone bas-droite)

Remplacer le bloc placeholder (Step 2) `waitingToasts.length > 0 ? <Toasts /> : <EventsPip connected={false} />`
par la version branchée :

```tsx
{waitingToasts.length > 0 ? (
  <Toasts
    items={waitingToasts}
    onOpen={handleToastOpen}
    onDismiss={dismiss}
  />
) : (
  <EventsPip connected={connected} />
)}
```

### 7.3 Modifications dans `App.tsx`

Cf. §6.2 — un import à retirer, un bloc JSX à retirer. C'est tout.

### 7.4 Suppression du fichier

`git rm packages/web/src/components/NotificationPanel.tsx`.

### 7.5 (Optionnel) Renommer `AUTO_DISMISS_MS` → exporter `TOAST_TTL_MS`

Dans `useEvents.ts` :

```ts
export const TOAST_TTL_MS = 30_000;
// ↓ remplacer toutes les occurrences de AUTO_DISMISS_MS par TOAST_TTL_MS
//   (1 seul site interne : ligne 78 `}, AUTO_DISMISS_MS);`)
```

### 7.6 Vérification (depuis `packages/web/`)

```bash
pnpm tsc --noEmit          # 0 erreur attendue
pnpm build                 # 0 erreur Vite
pnpm test                  # tous verts (aucun test ne touche NotificationPanel)
grep -rn "NotificationPanel" packages/web/src/   # 0 résultat
```

### 7.7 Docker redeploy (smoke live)

D'après la mémoire utilisateur :

```bash
cd /home/ubuntu/projets/swarm-os
docker build -t swarm-os:latest .
docker compose -f docker-compose.test.yml up -d
```

---

## 8. Tests de fumée

À exécuter manuellement après le redeploy (front Vite OU docker compose).

### 8.1 Fonctionnement EventsPip

1. Ouvrir `http://<host>:8080/#/` (token saisi). Aucun toast attendu.
2. Vérifier le pip bas-droite : `events :: live` (dot vert).
3. Stopper le backend (`docker compose stop` ou `kill` du process server).
4. Le pip doit passer en `events :: reconnecting…` (dot ambre) en
   < 10 s (timeout WS).
5. Redémarrer le backend. Le pip doit repasser en `live` en < 2 s.

### 8.2 Fonctionnement Toasts — apparition

1. Backend en marche, au moins 1 orchestrator actif avec ≥ 1 session.
2. Forcer une session en `waiting` (typiquement : envoyer du PTY input
   qui pousse l'agent à demander confirmation, OU déclencher le scénario
   de test S3 qui simule un waiting via `notification.dispatch`).
3. Vérifier : toast bas-droite apparait avec :
   - titre `SESSION WAITING`
   - heure relative (`Ns ago`)
   - `<TEAM_NAME> :: <AGENT_NAME>`
   - sessionId mono-font en bas
   - boutons `×` et `→ OPEN`
4. Bouton `→ OPEN` :
   - URL devient `#/orchestrators/<orchId>`
   - RightPanel s'ouvre sur la session correspondante (lead ou worker selon
     `sessionId` du frame)
   - Toast disparaît (auto-dismiss à l'open, cf. §7.2.4)
5. Bouton `×` :
   - Toast disparaît
   - Pas de navigation
6. Ne rien faire → après 30 s, toast disparaît automatiquement (timer
   `useEvents`).

### 8.3 Stacking + overflow

1. Forcer 7 sessions en `waiting` quasi-simultanément (différents
   sessionId).
2. Vérifier : 5 toasts visibles + ligne `+ 2 older waiting →` en haut.
3. Cliquer `+ 2 older waiting →` : navigue vers la 6e session
   (`items[5]` après reverse — = la 2e plus ancienne du paquet).
4. Une seule waiting réémise sur la même session : le toast existant est
   remplacé (pas duplicé) — la ligne `+N older` peut décrémenter.

### 8.4 Auto-dismiss

1. Déclencher un waiting, ne rien faire.
2. Vérifier qu'après 30 s pile, le toast disparaît du DOM.
3. Vérifier que les nouveaux waitings continuent d'apparaître normalement
   après (pas de leak de timer).

### 8.5 Bascule Toasts ↔ Pip

1. État initial : 1 toast visible (pip caché).
2. Cliquer `×` ou attendre 30 s → toast disparaît → pip
   `events :: live` réapparait immédiatement.

### 8.6 Suppression NotificationPanel — régression

1. `grep -rn "NotificationPanel" packages/web/` : aucun résultat dans
   `src/`. Fichier `NotificationPanel.tsx` absent.
2. `pnpm test` reste vert.
3. Vérifier qu'il n'y a qu'**une seule connexion WebSocket** `/ws/events`
   ouverte (DevTools → Network → WS) — preuve que `useEvents` n'est appelé
   qu'une seule fois (dans `DesktopShell`).

### 8.7 Reconnect : toasts persistent ?

1. Déclencher 1 toast `waiting`.
2. Stopper le backend (sans avoir cliqué dismiss).
3. Le pip ne s'affiche pas (1 toast > 0). Le toast reste affiché.
4. Au bout de 30 s, le toast disparaît (TTL local — le hook ne sait pas
   distinguer "session toujours waiting" de "session résolue").
5. Si le toast est encore présent quand le backend redémarre et émet à
   nouveau le waiting pour la même session, dedupe par `id` → 1 seul
   toast (timer reset).

### 8.8 Cas edge — orchestratorId absent

1. Simuler un frame `session.status_changed` sans `orchestratorId`
   (cas unknown).
2. Toast affiché avec `teamName = '—'` et `agentName = sessionId.slice(0,8)`.
3. Cliquer `→ OPEN` : `setSelectedSessionId` se fait mais
   `onOpenOrchestrator` n'est pas appelé (teamId vide). Le RightPanel
   tentera d'ouvrir sur la sessionId — comportement à valider selon B.7
   (peut donner un "no agent selected" si la session n'est dans aucun
   orchestrator connu).

---

## 9. Checklist d'acceptation Step 8

- [ ] `DesktopShell.tsx` appelle `useEvents()` une seule fois.
- [ ] `Toasts.tsx` reçoit `items` triés newest → oldest (reverse côté
      shell).
- [ ] `EventsPip.tsx` rendu uniquement quand `waiting.length === 0`,
      consomme `connected` du hook.
- [ ] Bouton `→ OPEN` navigue (`onOpenOrchestrator` + `setSelectedSessionId`)
      ET dismiss le toast.
- [ ] Bouton `×` dismiss seulement.
- [ ] Auto-dismiss 30 s vérifié (timer hook, pas composant).
- [ ] `NotificationPanel` retiré d'`App.tsx` (import + render).
- [ ] Fichier `NotificationPanel.tsx` supprimé du repo.
- [ ] `grep -rn "NotificationPanel" packages/web/src/` : 0 résultat.
- [ ] `pnpm tsc --noEmit` : 0 erreur.
- [ ] `pnpm test` : vert.
- [ ] DevTools : 1 seule WS `/ws/events` ouverte par onglet.
- [ ] Cap 5 + `+N older waiting →` fonctionnel (test §8.3).
- [ ] Reconnect WS reflété sur le pip en < 2 s après backend up
      (test §8.1).

---

## 10. Annexe — lignes de référence

| Référence | Fichier | Lignes |
|---|---|---|
| Source proto Toasts + EventsPip | `prototypes/v2/toasts.jsx` | 1-60 (intégral) |
| Skeleton Toasts.tsx | `docs/internal/ui-redesign/redesign-desktop/02_desktop-skeleton.md` | §3.17 |
| Skeleton EventsPip.tsx | `docs/internal/ui-redesign/redesign-desktop/02_desktop-skeleton.md` | §3.18 |
| Hook waiting + connected | `packages/web/src/hooks/useEvents.ts` | 33 (TTL), 66-154 (effet) |
| NotificationPanel à supprimer | `packages/web/src/components/NotificationPanel.tsx` | intégral (111 lignes) |
| Site de montage à retirer | `packages/web/src/App.tsx` | 4 (import), 196-199 (JSX) |
| Pattern `onOpenOrchestrator` Shell | `docs/internal/ui-redesign/redesign-desktop/03_routes-desktop-shell.md` | §6.1 (props), §6.2.4 (App) |
| Adapter teamName/agentName via `useOrchestrators` | `docs/internal/ui-redesign/redesign-desktop/04_topbar-data-binding.md` | §5.1 (lookup pattern) |
| TOAST_TTL_MS = 30000 | `prototypes/v2/toasts.jsx` | 7 + 59 |
| Mapping doc plan | `docs/internal/ui-redesign/ui-redesign-desktop.md` | §3.6 (Toasts), §5.1 step 8 |

— FIN du document Step 8 —
