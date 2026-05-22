# Étape 12 (Phase C.12) — Port de `BroadcastModal` v2

> **Périmètre exact** : porter le `BroadcastModal` du prototype v2
> (`prototypes/v2/modals.jsx:429-472`) dans
> `packages/web/src/components/desktop/BroadcastModal.tsx`, le déclencher
> depuis le clic sur le hub central `SWARM // BUS` de `MapView`, et
> implémenter le **workaround §4-1** : pas d'endpoint REST
> `/swarm/broadcast` côté serveur → itérer
> `api.broadcastToOrchestrator(id, text)` côté client sur tous les
> orchestrators actifs.
>
> Pré-requis :
> - Étape 1 (`desktop-theme.css`) — classes `.modal-backdrop`, `.modal`,
>   `.modal-head/body/foot`, `.field`, `.field-help`, `.btn.primary/ghost`,
>   `.pr-close` ;
> - Étape 2 (squelette `desktop/`) — `BroadcastModal.tsx` doit déjà
>   exister sous forme de stub (export `default` typé `Props`) ;
> - Étape 3 (`DesktopShell` lift) — `showBroadcast` doit être un state
>   `useState<boolean>` du `DesktopShell` ;
> - Étape 6 (`MapView` data-binding) — la prop `onHubClick: () => void`
>   doit être déjà câblée sur le `<g className="center-hub">` clickable.
>
> Backend : aucun changement (cf. gap §4-1 du plan parent). Utilise
> uniquement l'endpoint existant `POST /orchestrators/:id/broadcast` (S2,
> wrappé par `api.broadcastToOrchestrator`).

---

## 1. Objectif

Permettre à l'opérateur de diffuser un message texte
(`from: 'human'`) à **toutes les équipes actives** en un clic depuis le
hub central de la MapView, sans nouveau endpoint serveur. Le composant
agrège le résultat par team (succès / erreur), restitue un récap, et se
ferme proprement après envoi. C'est l'équivalent multi-team du
`BroadcastBar` existant (qui opère sur un seul orchestrator à la fois) et
l'unique chemin opérateur vers un broadcast cross-swarm tant que
`/swarm/broadcast` n'existe pas.

---

## 2. Source v2 — quoi reprendre, quoi adapter

### 2.1 Code source (`prototypes/v2/modals.jsx:429-472`)

```jsx
function BroadcastModal({ teams, onClose, onSend }) {
  const [txt, setTxt] = React.useState("");
  const activeTeams = teams.filter(t =>
    t.status !== "stopped" && t.status !== "exited" && t.status !== "killed"
  );
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <span style={{ color: "var(--amber)" }}>◇ BROADCAST</span>
            <span className="sub">// to all leads via swarm bus</span>
          </div>
          <button className="pr-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="field-help">
            This message is sent as <code>from='human'</code> to
            <b>{activeTeams.length}</b> active lead{activeTeams.length === 1 ? "" : "s"}:
            {activeTeams.map(t => t.name).join(" · ")}
          </div>
          <div className="field">
            <label>BROADCAST</label>
            <textarea
              value={txt}
              onChange={e => setTxt(e.target.value)}
              placeholder="e.g. &quot;Freeze all canary deploys…&quot;"
              autoFocus
              style={{ minHeight: 110 }}
            />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>CANCEL</button>
          <button
            className="btn primary"
            disabled={!txt.trim()}
            style={{ opacity: txt.trim() ? 1 : 0.4 }}
            onClick={() => onSend(txt.trim())}
          >
            BROADCAST →
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 2.2 À conserver tel quel

| Élément | Raison |
|---|---|
| Layout `.modal-backdrop > .modal > [head, body, foot]` | Cohérent avec les autres modales (Étape 9 / 13 / 14) — même thème warm-black. |
| Titre `◇ BROADCAST // to all leads via swarm bus` | Charte visuelle, le `◇` (diamond) rappelle l'icône hub de la MapView. |
| Bouton close `×` (`.pr-close`) | Parité avec les autres modales. |
| Backdrop click → `onClose` ; clic dans `.modal` → `e.stopPropagation()` | Comportement standard des modales v2. |
| `.field-help` qui liste les teams ciblées par nom | Transparence avant envoi : l'opérateur voit exactement ce qui sera touché. |
| `.field > label "BROADCAST" + textarea` `autoFocus`, `minHeight: 110` | Le focus arrive sur le textarea, l'opérateur tape immédiatement. |
| `disabled` + opacity sur le bouton `BROADCAST →` quand `!txt.trim()` | Parité avec les autres modales (`NewOrchestratorDialog`, `SpawnWorkerDialog`). |
| Texte `from='human'` dans la `field-help` | Reflète la sémantique backend `POST /orchestrators/:id/broadcast` (cf. `BroadcastBar.tsx:14` et `mailBubble.ts`). |

### 2.3 À adapter pour le workaround §4-1

| Adaptation | Pourquoi |
|---|---|
| **Props changent** : `teams` (mock `{ id, name, status }[]`) → `orchestrators: OrchestratorView[]` (vraies données via `useOrchestrators`). | Pas de `teams` mockés, on prend la liste réelle servie par le hook au niveau du `DesktopShell`. |
| **`onSend(text)` ne se contente pas d'appeler une fonction parent** : la modale détient elle-même la logique d'orchestration (boucle `broadcastToOrchestrator` + agrégation succès/erreur), parce que le résultat doit être affiché *dans* la modale (récap par team) avant fermeture. Le parent fournit uniquement `onClose` + la liste des orchestrators. | Le proto v2 délègue tout au parent (qui en local met juste à jour le state). Ici, la logique est trop spécifique (N appels REST + aggregation) pour rester dans le `DesktopShell`. On garde le composant **self-contained**. |
| **Filtre des "actifs"** : remplacer `t.status !== "stopped" && …` par un filtre fondé sur `OrchestratorView.endedAt` + `OrchestratorView.status` (cf. §3). | Le proto utilise une enum `status` qui n'est pas celle du backend (`'starting' \| 'running' \| 'stopping' \| 'stopped' \| 'failed'`). Aligner sur la source réelle. |
| **Ajout d'un état `submitting`** (pending REST calls) et désactivation du bouton + du textarea pendant l'envoi. | Évite double-submit ; cohérent avec `BroadcastBar.tsx:21,58,61`. |
| **Ajout d'un bloc récap** (post-envoi) affichant `N delivered`, `X errors`, et le détail par team (`✓ NOMAD: 3 sessions` / `✗ ATLAS: HTTP 401`). | Le proto n'a aucun feedback ; en réel, une partie des appels peut échouer (auth expirée, team killed pendant l'envoi). L'opérateur doit le savoir. |
| **Bouton `BROADCAST →` devient `CLOSE` après envoi** (et `CANCEL` reste actif). | Permet d'enchaîner un second envoi en éditant le textarea, sans rouvrir la modale. (Variante : auto-close 1.5 s après succès total — décision en §5.) |
| **Couleur `var(--amber)` du titre** : conservée. Pour les erreurs dans le récap, utiliser `var(--bad)` (cf. classe `.field-warn.error` proposée Étape 9). | Cohérence visuelle warm-black / amber pour les succès, rouge pour les échecs. |

### 2.4 À ne pas reprendre

| Élément | Raison |
|---|---|
| `teams` mock (`{ id, name, status, model, effort, ... }`) | Remplacé par `OrchestratorView[]`. |
| `onSend` direct côté parent | Encapsulé dans la modale (voir §2.3). |
| Aucune gestion d'erreur | Ajoutée en §4-§5. |

---

## 3. Filtre orchestrators actifs

### 3.1 Critère retenu

Un orchestrator est **actif** (= recevra un broadcast) si **toutes** ces
conditions sont vraies :

1. `orch.endedAt === null` — la team n'est pas terminée (ni `exited`, ni
   `killed`, ni `failed` clos en base, ni `server-restart` non-relancé).
   C'est le critère **primaire** utilisé partout dans `RECENTLY ENDED`
   (cf. `docs/redesign-desktop/05_leftpanel-data-binding.md` et le plan
   parent §3.2).
2. `orch.status === 'running'` **ou** `orch.status === 'starting'` —
   exclut explicitement `'stopping'` (transitionnel, le lead est en cours
   d'arrêt et le broadcast échouera sûrement) et `'stopped' / 'failed'`
   (déjà filtrés par `endedAt`, mais ceinture+bretelles).
3. `orch.leadSessionId !== null` — sans lead, `broadcastToOrchestrator`
   renvoie 0 delivery (le serveur push dans les mailboxes des sessions
   actives, le lead étant l'audience principale). On ne *bloque* pas le
   broadcast pour autant — la team apparaîtra dans le récap avec `0
   delivered`. **Décision** : on garde le filtre lâche
   (`endedAt === null` + `status in ['running','starting']`) et on laisse
   `delivered_to.length === 0` apparaître naturellement dans le récap.
   Un opérateur qui voit `STARTING (0 delivered, lead not ready)` saura
   réessayer.

### 3.2 Helper

```ts
function isActive(o: OrchestratorView): boolean {
  return o.endedAt === null && (o.status === 'running' || o.status === 'starting');
}
```

### 3.3 Note sur `'starting'`

On **inclut** les teams en `'starting'` :
- `POST /orchestrators/:id/broadcast` accepte les sessions `'starting'`
  côté serveur (le mailbox est créé dès l'instanciation de l'orchestrator,
  avant que le PTY du lead ne soit prêt — vérifier dans
  `packages/server/src/modules/orchestrator/mailbox.ts` ; comportement
  attendu : push dans le mailbox, signal idle ignoré tant que PTY pas
  prêt) ;
- Sinon on aurait un trou pendant les ~2 s entre `POST /orchestrators` et
  le passage en `'running'` — l'opérateur qui broadcast juste après la
  création d'une team serait surpris de ne pas la voir touchée.

Si un test révèle que le serveur renvoie 409 sur `'starting'`,
l'opération est **isolée à cette team** (cf. §4 — un échec par team ne
bloque pas les autres). Aucun risque collatéral.

### 3.4 Cas dégénéré : `activeOrchestrators.length === 0`

- Désactiver le bouton `BROADCAST →` ;
- Remplacer le récap par un `.field-help` : `No active teams — start one
  via + NEW TEAM`.
- Garder la modale ouvrable et fermable (clic backdrop, `×`, `CANCEL`).

---

## 4. `Promise.all` vs séquentiel — choix et report d'erreur

### 4.1 Choix : `Promise.allSettled`

```ts
const results = await Promise.allSettled(
  activeOrchestrators.map(o =>
    api.broadcastToOrchestrator(o.id, text).then(r => ({
      orchestratorId: o.id,
      name: o.name,
      deliveredCount: r.delivered_to.length,
    }))
  )
);
```

**Pourquoi `Promise.allSettled` (et non `Promise.all` ni séquentiel)** :

| Stratégie | Pour | Contre | Verdict |
|---|---|---|---|
| **Séquentiel** (`for…of` avec `await`) | Ordre strict, log lisible | Latence cumulée (~50 ms × N teams = 1 s à 20 teams) ; un timeout au milieu retarde tout | ❌ rejeté |
| **`Promise.all`** | Parallèle, rapide | Le premier échec **rejette toute la promise** et les autres résultats sont perdus | ❌ rejeté |
| **`Promise.allSettled`** | Parallèle ET récupère tous les résultats (`fulfilled` + `rejected`) | Légèrement plus verbeux (extraction `value`/`reason`) | ✅ **retenu** |

L'argument décisif : on a **besoin** de connaître les succès partiels.
Si 5 teams sur 6 reçoivent le broadcast et qu'une seule timeout,
l'opérateur doit savoir laquelle (et que les 5 autres sont OK). Avec
`Promise.all` cette info est perdue.

### 4.2 Limitation côté serveur ?

Le serveur backend traite les broadcasts indépendamment par
orchestrator — il n'y a pas de verrou global. Tirer 6-10
`broadcastToOrchestrator` en parallèle est sans risque (vérifié dans
`packages/server/src/modules/orchestrator/api.ts` autour de la route
`/broadcast`). Au-delà de ~20 teams concurrentes, on pourrait throttler
(p-limit), mais c'est hors scope v1 (aucune installation connue n'a >10
teams actives).

### 4.3 Forme du rapport par team

```ts
interface PerTeamResult {
  orchestratorId: string;
  name: string;
  ok: boolean;
  deliveredCount?: number;
  error?: string;
}

const perTeam: PerTeamResult[] = results.map((r, i) => {
  const o = activeOrchestrators[i];
  if (r.status === 'fulfilled') {
    return { orchestratorId: o.id, name: o.name, ok: true, deliveredCount: r.value.deliveredCount };
  }
  return {
    orchestratorId: o.id,
    name: o.name,
    ok: false,
    error: r.reason instanceof Error ? r.reason.message : String(r.reason),
  };
});

const summary = {
  total: perTeam.length,
  okCount: perTeam.filter(p => p.ok).length,
  errorCount: perTeam.filter(p => !p.ok).length,
  deliveredTotal: perTeam.reduce((acc, p) => acc + (p.deliveredCount ?? 0), 0),
};
```

### 4.4 Rendu du récap

- **Ligne agrégée** (toujours visible après envoi) :
  `✓ Reached N team(s), M session(s) delivered` (vert si `errorCount === 0`,
  ambre si succès partiel, rouge si `okCount === 0`).
- **Détail par team** (liste sous le résumé, max 10 visibles + `+K more`) :
  - succès : `<span class="dot ok"></span> NOMAD :: 3 delivered`
  - échec  : `<span class="dot bad"></span> ATLAS :: HTTP 401 Unauthorized`

Les classes `.dot.ok` / `.dot.bad` existent déjà dans
`desktop-theme.css` (utilisées dans `SettingsDrawer` cf. Étape 11).

---

## 5. UX

### 5.1 Phases de la modale

| Phase | État interne | Affichage |
|---|---|---|
| **Idle** (à l'ouverture) | `submitting=false`, `result=null`, `txt=''` | Header + `.field-help` qui liste les teams cibles + textarea autofocus + footer `CANCEL` / `BROADCAST →` (disabled tant que `!txt.trim()`) |
| **Submitting** | `submitting=true`, `result=null` | Textarea `disabled`, bouton `BROADCAST →` devient `SENDING…` + désactivé, `CANCEL` désactivé aussi (évite fermeture pendant fly-by réseau) |
| **Done** | `submitting=false`, `result=PerTeamResult[]` | `.field-help` remplacé par bloc récap (§4.4) ; textarea **reset** (`txt=''`) **et** réactivé pour un éventuel second envoi ; bouton primaire redevient `BROADCAST →` (disabled tant que `!txt.trim()`), `CANCEL` devient `CLOSE` (libellé court, action identique = `onClose`) |

### 5.2 Auto-close ?

**Décision** : pas d'auto-close. L'opérateur garde la main pour relire
le récap, éventuellement réessayer une team en échec (en retapant + en
re-broadcastant — pour l'instant on ne fait pas de retry sélectif, c'est
un follow-up §11). L'auto-close serait une régression UX par rapport au
besoin de feedback.

### 5.3 Keyboard

- `Cmd/Ctrl + Enter` dans le textarea → `handleSend()` (parité avec
  `BroadcastBar.tsx:42`).
- `Esc` → `onClose()` si **pas** en `submitting`. (À implémenter via
  `useEffect` listener `keydown` global, cf. §11 — non-bloquant si
  reporté.)

### 5.4 Limites de saisie

- Pas de `maxLength` côté UI (le backend accepte du texte libre, le
  `team.read_inbox` retourne tel quel). Si un opérateur colle 50 KB,
  c'est son problème : un `.field-help` discret peut ajouter
  `(N chars)` sous le textarea pour transparence. **Décision** :
  afficher `{txt.length} chars` quand `txt.length > 500`.
- Pas de validation de format — le contenu est du texte brut destiné aux
  agents.

### 5.5 Accessibilité

- `role="dialog"`, `aria-modal="true"` sur `.modal`.
- `aria-labelledby` qui pointe sur le titre.
- `aria-live="polite"` sur le bloc récap (annonce le résultat aux SR).
- Focus retourne sur le hub (le composant qui a ouvert la modale) à la
  fermeture — à gérer dans `MapView.tsx` ou `DesktopShell` (ref sur le
  bouton hub, focus restoration à `onClose`).

---

## 6. Composant complet (JSX final)

```tsx
// packages/web/src/components/desktop/BroadcastModal.tsx
import { useEffect, useMemo, useState } from 'react';
import { api, type OrchestratorView } from '../../api/client';

interface Props {
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

export default function BroadcastModal({ open, onClose, orchestrators }: Props) {
  const [txt, setTxt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  const activeOrchestrators = useMemo(
    () => orchestrators.filter(isActive),
    [orchestrators],
  );

  // Reset state on (re)open
  useEffect(() => {
    if (open) {
      setTxt('');
      setSubmitting(false);
      setResult(null);
    }
  }, [open]);

  // Esc to close (only when idle / done — not while submitting)
  useEffect(() => {
    if (!open || submitting) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const canSend = txt.trim().length > 0 && !submitting && activeOrchestrators.length > 0;

  async function handleSend() {
    const trimmed = txt.trim();
    if (!trimmed || submitting || activeOrchestrators.length === 0) return;
    setSubmitting(true);
    setResult(null);
    const settled = await Promise.allSettled(
      activeOrchestrators.map((o) =>
        api.broadcastToOrchestrator(o.id, trimmed).then((r) => ({
          deliveredCount: r.delivered_to.length,
        })),
      ),
    );
    const perTeam: PerTeamResult[] = settled.map((s, i) => {
      const o = activeOrchestrators[i];
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
            <span className="sub">// to all leads via swarm bus</span>
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
              This message is sent as <code>from='human'</code> to{' '}
              <b style={{ color: 'var(--text)' }}>{activeOrchestrators.length}</b>{' '}
              active lead{activeOrchestrators.length === 1 ? '' : 's'}:&nbsp;
              {activeOrchestrators.map((o) => o.name).join(' · ')}
            </div>
          )}

          {/* No active teams */}
          {!result && activeOrchestrators.length === 0 && (
            <div className="field-help">
              No active teams. Start one via <b>+ NEW TEAM</b> in the TopBar.
            </div>
          )}

          {/* Textarea */}
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

          {/* Post-send recap */}
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
                {result.errorCount > 0 && <> · <b>{result.errorCount}</b> error{result.errorCount === 1 ? '' : 's'}</>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
                {result.perTeam.slice(0, 10).map((p) => (
                  <div key={p.orchestratorId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
```

### 6.1 Dépendances CSS attendues

Toutes déjà fournies par `desktop-theme.css` (Étape 1) :
- `.modal-backdrop`, `.modal`, `.modal-head`, `.modal-body`, `.modal-foot`
- `.modal-title`, `.modal-title .sub`
- `.field`, `.field > label`, `.field > textarea`, `.field-help`
- `.btn`, `.btn.primary`, `.btn.ghost`
- `.pr-close`
- `.dot`, `.dot.ok`, `.dot.bad`
- Variables : `--amber`, `--ok`, `--warn`, `--bad`, `--text`, `--text-dim`, `--text-mute`

Aucune classe nouvelle à introduire dans `desktop-theme.css`.

---

## 7. Câblage `MapView` ↔ `DesktopShell` ↔ `BroadcastModal`

### 7.1 Lift du state `showBroadcast`

Le state vit dans `DesktopShell` (cf. Étape 3 — orchestration des
overlays). Forme attendue :

```tsx
// packages/web/src/components/desktop/DesktopShell.tsx (extrait)
const [showBroadcast, setShowBroadcast] = useState(false);

const { orchestrators } = useOrchestrators();  // déjà branché Étape 4

return (
  <div className="desktop-shell">
    <TopBar … />
    <div className="grid">
      <LeftPanel … />
      <MapView
        orchestrators={orchestrators}
        onSelect={setSelectedSessionId}
        onHubClick={() => setShowBroadcast(true)}   // ← câblage hub
        …
      />
      <RightPanel … />
    </div>
    <Toasts … />
    <EventsPip … />

    {/* Overlays */}
    {/* … autres modals (NewOrch, Roles, Settings, SpawnWorker, EditCfg) … */}
    <BroadcastModal
      open={showBroadcast}
      onClose={() => setShowBroadcast(false)}
      orchestrators={orchestrators}
    />
  </div>
);
```

### 7.2 Hub clickable dans `MapView`

`MapView.tsx` (Étape 2 squelette + Étape 6 data) doit déjà rendre le hub
central avec un `<g className="center-hub">` ou similaire. On y branche
`onClick={() => props.onHubClick?.()}` et `style={{ cursor: 'pointer' }}`.
Source de référence : `prototypes/v2/map.jsx:262-281` (`<g className="center-hub" onClick={() => setOverlay({type:'broadcast'})}>`).

**Props ajoutées à `MapView`** (cf. interface existante de Step 2) :

```ts
interface MapViewProps {
  // … existant
  onHubClick?: () => void;
}
```

Le hub est composé typiquement de :
- un `<circle>` glow ambré ;
- un `<circle>` core noir ;
- deux lignes de texte `SWARM` / `// BUS`.

Le `onClick` se pose sur le `<g>` parent. Le `cursor: pointer` est porté
soit via `className="center-hub clickable"` (à définir dans CSS) soit via
inline style.

### 7.3 Pas de toggle ouvrir/refermer au clic

Comportement : le clic hub **ouvre toujours** la modale (idempotent ;
deuxième clic = idem, état recyclé via `useEffect([open])` du composant).
La modale se ferme uniquement via backdrop, `×`, `CANCEL`/`CLOSE` ou
`Escape`. Pas de re-clic sur le hub pour fermer (le hub est invisible
sous la modale, de toute façon).

### 7.4 Pourquoi pas de `useOrchestrators` interne au modal ?

Si la modale appelait `useOrchestrators()` elle-même, on aurait **deux
polls 3 s** concurrents (un dans `DesktopShell`, un dans la modale). On
prend la liste depuis le parent en prop, garantie cohérente avec ce que
voit la `MapView` à l'instant T du clic. Le polling continue dans
`DesktopShell` ; si une team passe `endedAt !== null` *pendant* que la
modale est ouverte, on aura un re-render et le filtre `isActive` la
recalcule. **Comportement correct**.

---

## 8. Plan d'implémentation pas-à-pas

1. **Pré-requis Étapes 1-3-6** : vérifier que
   - `desktop-theme.css` est importé depuis `main.tsx` et expose les
     classes du §6.1 ;
   - `BroadcastModal.tsx` existe en stub (créé à l'Étape 2) avec
     `export default function BroadcastModal() { return null; }` ;
   - `DesktopShell.tsx` a déjà un slot `{/* overlays */}` et un state
     `showBroadcast` (ou est prêt à le recevoir) ;
   - `MapView.tsx` a un `<g className="center-hub">` rendu et accepte
     (au pire en TODO) une prop `onHubClick`.
2. **Réécriture intégrale de `BroadcastModal.tsx`** avec le code §6.
   Conserver `export default`.
3. **Câblage dans `DesktopShell.tsx`** : ajouter le `useState`, passer
   `onHubClick={() => setShowBroadcast(true)}` à `MapView`, monter
   `<BroadcastModal open onClose orchestrators />` dans la zone overlays.
4. **Câblage dans `MapView.tsx`** :
   - Ajouter `onHubClick?: () => void` à `MapViewProps` ;
   - Sur le `<g className="center-hub">`, ajouter
     `onClick={() => onHubClick?.()}` et `style={{ cursor: 'pointer' }}` ;
   - Si possible, ajouter un `aria-label="Open broadcast modal"` + `role="button"` + `tabIndex={0}` pour l'a11y clavier (Enter/Space).
5. **Tests Vitest** (nouveau fichier `BroadcastModal.test.tsx`) — voir §9 ;
   au minimum :
   - rendu when `open=true` avec teams actives,
   - rendu when `open=true` sans teams actives,
   - `handleSend` appelle `api.broadcastToOrchestrator` une fois par
     team active,
   - succès partiel : un mock qui rejette pour une team affiche le
     récap correct,
   - bouton désactivé quand `txt.trim()` vide.
6. **QA visuelle** (`docker build -t swarm-os:latest .` puis
   `docker compose -f docker-compose.test.yml up -d` cf. mémoire user) :
   exécuter les tests de fumée §9.
7. **Documentation** : aucune modification à
   `docs/ui-redesign-desktop.md` (le présent doc est l'étape détaillée
   référencée par §5.1 step 12).
8. **Suivi** : créer une issue de follow-up "S13/14 — `POST
   /swarm/broadcast` atomique côté serveur" (cf. §11) pour pouvoir
   remplacer la boucle client par un appel unique plus tard (gap §4-1
   du plan parent).

---

## 9. Tests de fumée

À jouer manuellement dans l'app dockerisée après build (`docker build -t
swarm-os:latest .` + `docker compose -f docker-compose.test.yml up -d`,
cf. mémoire `project_docker_redeploy.md`).

1. **Ouvrir la modale** : cliquer sur le hub central `SWARM // BUS` →
   modale apparaît, titre `◇ BROADCAST // to all leads via swarm bus`,
   textarea autofocus, `.field-help` liste les N teams cibles
   (`from='human'` to N active leads: NOMAD · ATLAS · …`).
2. **Cas zéro teams actives** : stopper toutes les teams (DELETE via
   bouton STOP) → rouvrir la modale → message
   `No active teams. Start one via + NEW TEAM in the TopBar.`, bouton
   `BROADCAST →` disabled.
3. **Disabled empty** : modale ouverte, textarea vide → bouton `BROADCAST
   →` disabled (opacity 0.4). Taper un caractère → bouton s'active.
4. **Envoi nominal (1 team)** : 1 team active, taper `freeze all canary
   deploys` → cliquer `BROADCAST →` → bouton passe à `SENDING…` puis
   récap : `✓ Reached 1/1 team · 3 sessions delivered` (le nombre
   dépend du nombre de workers). Détail : `<dot ok> NOMAD :: 3
   delivered`. Textarea revient vide. Bouton primaire repasse à
   `BROADCAST →`. Bouton ghost passe à `CLOSE`.
5. **Envoi nominal (N teams)** : 3 teams actives → broadcast → 3 lignes
   dans le détail, toutes vertes, total `Reached 3/3 teams · X
   delivered`.
6. **Succès partiel** : 3 teams, une avec un lead juste killed (mais
   pas encore `endedAt`) — soit on simule en `docker kill` du process
   lead → broadcast → récap mixte : 2 vertes, 1 rouge avec message
   d'erreur HTTP (probablement `404 SESSION_NOT_FOUND` ou `409`).
   Couleur du résumé : ambre (`⚠`).
7. **Échec total** : couper le token (Settings → CLEAR → broadcast) →
   tous en rouge, résumé rouge `✗ Reached 0/3 teams · 0 delivered · 3
   errors`. Restaurer le token.
8. **Cmd/Ctrl+Enter** : taper du texte + `Cmd+Enter` → envoi déclenché
   identique au clic bouton.
9. **Esc en idle** : modale ouverte, pas de saisie en cours, presser
   `Esc` → modale se ferme.
10. **Esc en submitting** : déclencher un broadcast lent (taper, cliquer
    SEND), pendant `SENDING…` presser `Esc` → modale **reste ouverte**
    (le listener Esc est désactivé pendant `submitting`).
11. **Backdrop click en submitting** : pendant `SENDING…`, cliquer le
    backdrop → rien ne se passe (`onClick` du backdrop ne déclenche
    `onClose` que si `!submitting`).
12. **Second broadcast** : après un envoi réussi, le récap est affiché,
    le textarea est vide et réactivé. Retaper un nouveau message →
    cliquer `BROADCAST →` → nouveau cycle, récap remplacé par le
    nouveau.
13. **Vérif backend** : avant/après broadcast, `curl -H "X-Auth-Token:
    $TOKEN" http://localhost:8080/orchestrators/$ID` puis
    `curl http://localhost:8080/orchestrators/$ID/sessions/$LEAD_ID/inbox`
    → la dernière entrée a `from === 'human'` et `content` correspondant.
14. **Vérif pulses MapView** : pendant un broadcast multi-team, vérifier
    que les pulses kind `broadcast` (ou `human`, selon la classification
    dérivée de l'event `mailbox.message`) apparaissent depuis le hub
    vers chaque lead.
15. **A11y screen reader** (optionnel) : avec NVDA/VoiceOver, naviguer
    jusqu'au hub avec Tab (si `tabIndex=0` ajouté §8.4) → Enter ouvre la
    modale. Le récap est annoncé via `aria-live="polite"`.

---

## 10. Risques & points d'attention

1. **N requêtes parallèles** : à 20+ teams actives on saturera
   éventuellement la connexion (HTTP/1.1 limit ~6 connexions par
   origine). Pas un blocage v1 ; mitigation future via `p-limit(5)`. Le
   `Promise.allSettled` est robuste si certaines requêtes timeout.
2. **`OrchestratorView.status === 'starting'`** : si le serveur rejette
   le broadcast pendant `starting` (vérification empirique pendant les
   tests), le récap montrera ces teams en erreur. À surveiller. Si c'est
   trop bruyant, exclure `'starting'` du filtre (cf. §3.3).
3. **Course endedAt** : entre le moment où la modale est ouverte et le
   moment du clic SEND, une team peut passer `endedAt !== null` (lead
   crash, etc.). Le `useMemo([orchestrators])` se re-calcule à chaque
   poll 3 s — donc on enverra effectivement à la liste *au moment du
   clic*, pas à la liste *au moment de l'ouverture*. Comportement
   acceptable. (Variante stricte : freezer `activeOrchestrators` au
   moment du click, à coder si demandé.)
4. **Erreurs réseau silencieuses** : `fetch` qui timeout ne reject pas
   tant qu'il n'y a pas de signal. Le client `request<T>` (cf.
   `api/client.ts`) n'a pas de timeout explicite. Si un broadcast pend
   indéfiniment, le bouton restera en `SENDING…` sans recours. À
   monitorer ; ajouter un `AbortController` avec timeout 10 s côté
   `request` est un follow-up générique (toucherait tous les appels).
5. **Z-index** : le `.modal-backdrop` (z-index ~100) doit être au-dessus
   des autres overlays mais sous les toasts (z-index ~200 pour qu'ils
   restent visibles pendant la modale). Vérifier en QA.
6. **Cohabitation avec d'autres modales** : si l'opérateur ouvre
   simultanément `NewOrchestratorDialog` (peu probable mais
   théoriquement possible si on clique le hub avant que l'autre modale
   ne soit visible), les deux backdrops se cumulent. Cas dégénéré, à
   ne pas optimiser.
7. **`text.length` huge** : le serveur peut refuser au-delà d'une
   certaine taille (à vérifier dans `packages/server/src/modules/orchestrator/api.ts`
   — taille max du body Fastify). En cas d'erreur HTTP 413, le récap
   l'affiche team par team. Bornes UI optionnelles (`maxLength=8000`)
   sont un follow-up.
8. **Pas de retry** : un opérateur qui voit 1 team en erreur et 5 OK
   ne peut pas réenvoyer uniquement à la 1ère ; il devra retaper et
   re-broadcaster à *toutes*, ce qui crée des doublons côté inbox sur
   les 5 déjà servies. Acceptable v1 (cas rare) ; un bouton "retry
   failed only" est un follow-up §11.

---

## 11. Follow-ups (hors scope C.12)

- **Endpoint `POST /swarm/broadcast` atomique** côté serveur (gap §4-1
  du plan parent) — permettrait de remplacer la boucle client par un
  unique appel REST, plus rapide et qui pourrait garantir une atomicité
  (tout-ou-rien) ou un mode best-effort équivalent. À planifier dans
  une phase S13/S14.
- **`p-limit`** sur les `broadcastToOrchestrator` parallèles si > 10
  teams actives.
- **Bouton "Retry failed"** dans le récap, qui réémet uniquement aux
  teams en erreur (utile dès qu'il y a > 5 teams).
- **`AbortController`** + timeout 10 s côté `api/client.ts request()`
  — bénéfice transverse pour tous les calls.
- **Esc et focus restoration** : encapsuler dans un hook `useModal({
  onClose })` partagé par toutes les modales du `desktop/`.
- **Persist last broadcast** dans `sessionStorage` pour le retrouver
  au reload (rare mais demandé en interne).

---

## 12. Récap des fichiers touchés

| Fichier | Action |
|---|---|
| `packages/web/src/components/desktop/BroadcastModal.tsx` | **Réécriture intégrale** depuis le stub Étape 2 |
| `packages/web/src/components/desktop/MapView.tsx` | Ajout prop `onHubClick?: () => void` + câblage `onClick` sur `<g className="center-hub">` (+ `cursor: pointer`, idéalement `tabIndex=0` + `aria-label`) |
| `packages/web/src/components/desktop/DesktopShell.tsx` | Ajout state `showBroadcast` + passage de `onHubClick` à `MapView` + montage de `<BroadcastModal …>` |
| `packages/web/src/components/desktop/BroadcastModal.test.tsx` | **Nouveau fichier** — tests Vitest (cf. §8 step 5) |
| `packages/web/src/styles/desktop-theme.css` | **Aucun changement** (toutes les classes existent déjà depuis Étape 1) |
| `packages/web/src/api/client.ts` | **Aucun changement** (`broadcastToOrchestrator` déjà exposé) |
| `packages/web/src/hooks/useOrchestrators.ts` | **Aucun changement** (consommé via le `DesktopShell`) |
| `packages/web/src/components/BroadcastBar.tsx` | **Aucun changement** — conserver tant que `OrchestratorView.tsx` existe (single-team broadcast). Sera supprimé en même temps qu'`OrchestratorView.tsx` lors de la finalisation Phase B/C. |

---

## 13. Ce que cette étape NE fait PAS

- Pas d'endpoint serveur `/swarm/broadcast` (gap §4-1, follow-up).
- Pas de retry sélectif des teams en erreur.
- Pas de timeout réseau (`AbortController`) côté client.
- Pas de suppression de `BroadcastBar.tsx` (toujours utilisé tant que
  `OrchestratorView.tsx` n'est pas démantelé — cf. plan parent §5.2).
- Pas de support `paste` enrichi (image, fichier) — texte brut.
- Pas de persistance entre ouvertures (chaque ouverture remet `txt=''`
  et `result=null`).
- Pas de raccourci global (`g b` style Linear) pour ouvrir la modale —
  unique entrée = clic hub. Possible follow-up.
