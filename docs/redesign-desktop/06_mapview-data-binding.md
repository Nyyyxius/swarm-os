# Step 6 (Phase B.6) — Brancher `MapView` aux données réelles

> Lié au plan global `docs/ui-redesign-desktop.md` §3.3 (MapView mapping),
> §1.3 (ROLE_SHAPE), §5.1 step 6, §5.4 risque #2 (perf pulses).
> Pré-requis : Step 2 (squelette MapView/Node/NodeShape/layoutTeams) **et**
> Step 3 (DesktopShell lift `selectedSessionId`) doivent être livrés. La
> source de vérité reste `prototypes/v2/map.jsx` (lignes 1-453).

## 1. Objectif

Remplacer les données de démo (`window.TEAMS_INIT`) que consomme le squelette
de `MapView.tsx` par les vraies données serveur : `OrchestratorView[]` (poll
3 s via `useOrchestrators`), `SessionView` enrichi via `enrichWithIdle` (S6),
compteurs d'inbox via `peekInbox` (poll 3 s), et pulses dérivés en temps
réel de l'event WS `mailbox.message` (S2). On garde le SVG/pan/zoom/hub/HUD
inchangés ; seuls les *inputs* changent.

## 2. Modèle de données — `OrchestratorView[]` → `MapViewTeam[]`

Le squelette de Step 2 attend une structure `MapViewTeam` (extends
`MapTeam`) avec :

```ts
interface MapTeam {
  id: string;
  angle: number;
  lead: { id: string };
  workers: { id: string }[];
}
interface MapViewTeam extends MapTeam {
  status: string;
  lead: NodeAgent;          // Node + shape + status
  workers: NodeAgent[];
}
interface NodeAgent {
  id: string;
  name: string;
  role: string;
  shape: Shape;
  status: string;
  inbox?: number;
}
```

### 2.1 Dérivation (un helper `toMapViewTeams`)

À placer dans `desktop/MapView.tsx` (ou extrait en `desktop/mapTeams.ts`
si on veut tester séparément). Entrées : `orchestrators` (raw), `now`
(`useNow()` 1 s ou 5 s), `inboxCounts` (`Map<sessionId, number>`).

```ts
import { enrichWithIdle } from '../../lib/sessionStatus';
import { shapeForRole } from '../../lib/roleShape';
import type { OrchestratorView, SessionView } from '../../api/client';
import type { MapViewTeam } from './MapView';
import type { NodeAgent } from './Node';

const TAU = Math.PI * 2;

/** Convert a raw SessionView into a NodeAgent suitable for the MapView. */
function toNodeAgent(
  s: SessionView,
  now: number,
  inboxCount: number,
): NodeAgent {
  // enrichWithIdle gives `IDLE` only if `running` && silent > 30 s.
  // We keep the raw status when the visual maps to anything else
  // (waiting, starting, failed, paused, exited, killed, interrupted) so
  // the Node component can choose the right ring/dot/label.
  const v = enrichWithIdle(s, now);
  // enrichWithIdle returns a VisualDescriptor, but Node wants the raw
  // status string ('running' / 'waiting' / 'idle' / 'starting' / …).
  // The only override we apply is `running → idle` when v.visual === 'idle'.
  const status = v.visual === 'idle' ? 'idle' : s.status;
  return {
    id: s.id,
    name: s.name,
    role: s.role,
    shape: shapeForRole(s.role),
    status,
    inbox: inboxCount,
  };
}

/**
 * Build the MapViewTeam[] consumed by MapView from a snapshot of
 * orchestrators. Angles are computed from the count N so the leads sit on
 * a regular orbit around the central hub:
 *
 *     angle_i = (i / N) * 2π - π/2
 *
 * (start at 12 o'clock — i = 0 → top, then clockwise).
 *
 * Orchestrators without a lead session (status === 'starting' before the
 * lead PTY is born) are skipped — MapView cannot lay them out without a
 * lead Node. They'll appear on the next poll once `leadSessionId` is set.
 */
export function toMapViewTeams(
  orchestrators: readonly OrchestratorView[],
  now: number,
  inboxCounts: ReadonlyMap<string, number>,
): MapViewTeam[] {
  // Filter live + ended-but-recent (RECENTLY ENDED is rendered in
  // LeftPanel, not in MapView). MapView shows only orchestrators that
  // still have at least one session known to the server.
  const live = orchestrators.filter(
    (o) => o.sessions.length > 0 && o.leadSessionId != null,
  );
  const N = Math.max(1, live.length);
  return live.map((o, i): MapViewTeam | null => {
    const leadSession = o.sessions.find((s) => s.id === o.leadSessionId);
    if (!leadSession) return null;
    const workers = o.sessions.filter((s) => s.type === 'worker');
    const angle = (i / N) * TAU - Math.PI / 2;
    return {
      id: o.id,
      angle,
      status: o.status,                       // server OrchestratorStatus
      lead: toNodeAgent(leadSession, now, inboxCounts.get(leadSession.id) ?? 0),
      workers: workers.map((w) =>
        toNodeAgent(w, now, inboxCounts.get(w.id) ?? 0),
      ),
    };
  }).filter((t): t is MapViewTeam => t !== null);
}
```

Notes :
- `session.type` est déjà sur `SessionView` (`'lead' | 'worker'`,
  `client.ts:79`). On préfère filtrer sur `s.type === 'worker'` + retrouver
  le lead via `o.leadSessionId` plutôt que de présupposer un ordre dans
  `o.sessions`.
- L'angle est calculé **au moment de la dérivation**, pas stocké côté
  serveur. Conséquence : si une team disparaît, les autres se redistribuent
  sur le cercle au prochain render. Acceptable — fluidité visuelle assurée
  par l'animation CSS native du `transform=translate(...)` du `<g>` Node
  (déjà présente dans le thème : `.node { transition: transform 600ms
  ease; }` — à vérifier dans `desktop-theme.css`, ajouter si absent).
- L'ordre de `live` détermine l'angle. `useOrchestrators` renvoie l'ordre
  serveur (creation order, conservé entre polls). Pas de tri additionnel
  pour éviter de faire pivoter la map à chaque nouvelle team.

## 3. `layoutTeams.ts` — implémentation TypeScript (Step 2, inchangée)

Le squelette Step 2 livre déjà `layoutTeams` (`desktop/layoutTeams.ts`).
Pour mémoire — l'implémentation **reste exactement** celle-ci, **on ne la
modifie pas en Step 6** (Step 6 ne fait qu'alimenter `teams` avec de
vraies données dérivées au §2.1) :

```ts
// packages/web/src/components/desktop/layoutTeams.ts
export const VBW = 1200;
export const VBH = 900;
export const CENTER: { x: number; y: number } = { x: VBW / 2, y: VBH / 2 };
export const LEAD_RADIUS = 320;
export const WORKER_RADIUS = 150;
export const WORKER_SPREAD = 1.55;

export interface MapAgent { id: string }
export interface MapTeam {
  id: string;
  angle: number;        // calculé en amont via (i / N) * 2π - π/2
  lead: MapAgent;
  workers: MapAgent[];
}
export interface NodePosition {
  x: number;
  y: number;
  teamId: string;
  leadId?: string;
}

export function layoutTeams(teams: readonly MapTeam[]): Record<string, NodePosition> {
  const positions: Record<string, NodePosition> = {};
  teams.forEach((team) => {
    const lx = CENTER.x + Math.cos(team.angle) * LEAD_RADIUS;
    const ly = CENTER.y + Math.sin(team.angle) * LEAD_RADIUS;
    positions[team.lead.id] = { x: lx, y: ly, teamId: team.id };
    const n = team.workers.length;
    team.workers.forEach((w, i) => {
      const outward = team.angle;
      const offset = n === 1 ? 0 : (i / (n - 1) - 0.5) * WORKER_SPREAD;
      const a = outward + offset;
      const wx = lx + Math.cos(a) * WORKER_RADIUS;
      const wy = ly + Math.sin(a) * WORKER_RADIUS;
      positions[w.id] = { x: wx, y: wy, teamId: team.id, leadId: team.lead.id };
    });
  });
  return positions;
}
```

Formule angles (vérifiée vs `v2/data.jsx`) :
- Position lead : `(LEAD_RADIUS·cos(angle) + 600, LEAD_RADIUS·sin(angle) + 450)` dans le repère SVG.
- Position worker `i` (i ∈ [0..n-1]) : `outward = team.angle` ; `offset = (i / (n-1) - 0.5) * 1.55` (n=1 → offset = 0, recouvrement centré).
- Workers répartis sur un **arc** centré sur le lead, de rayon 150, ouvert dans la direction radiale opposée au hub.

## 4. ROLE_SHAPE — table figée

Copiée littéralement de `prototypes/v2/data.jsx:117-127` (déjà portée en
`packages/web/src/lib/roleShape.ts` au Step 2). On la rappelle ici car
c'est l'input clé de `toNodeAgent` :

| Role string    | NodeShape       |
|----------------|-----------------|
| `ORCHESTRATOR` | `diamond`       |
| `RESEARCHER`   | `circle`        |
| `BUILDER`      | `triangle`      |
| `CRITIC`       | `diamondS`      |
| `ANALYST`      | `halfmoon`      |
| `MEMORY`       | `dot`           |
| `TOOLS`        | `square`        |
| _(autre)_      | `circle` (fallback `shapeForRole`) |

```ts
// packages/web/src/lib/roleShape.ts (Step 2, à utiliser tel quel)
export type Shape = 'diamond' | 'diamondS' | 'triangle' | 'square'
                  | 'dot' | 'halfmoon' | 'circle';
export const ROLE_SHAPE: Record<string, Shape> = {
  ORCHESTRATOR: 'diamond',
  RESEARCHER: 'circle',
  BUILDER: 'triangle',
  CRITIC: 'diamondS',
  ANALYST: 'halfmoon',
  MEMORY: 'dot',
  TOOLS: 'square',
};
export function shapeForRole(role: string): Shape {
  return ROLE_SHAPE[role] ?? 'circle';
}
```

**Notes** :
- Les roles côté serveur sont des **strings libres** (`SessionView.role:
  string`, `client.ts:78`) — l'opérateur peut créer un role custom via la
  RolesPage avec un label arbitraire ("HUNTER", "PARSER", etc.).
  `shapeForRole` retombe alors sur `circle`. C'est le comportement v1
  voulu (§1.3 fallback explicite).
- Pour la consistance avec le proto, l'`OrchestratorView.role` du lead est
  toujours `'ORCHESTRATOR'` (forcé côté serveur, cf. roles.ts) ;
  `SessionView.role` du lead l'est aussi → forme diamond garantie.

## 5. Pulses pipeline

### 5.1 Source — l'event `mailbox.message` (S2)

Le serveur émet sur `/ws/events` un event de la forme (cf. `client.ts`
JSDoc + `useEvents.ts:17-23` pour l'interface) :

```ts
{
  kind: 'mailbox.message',
  ts: string,                          // ISO
  orchestratorId: string,              // destinataire (lead orch)
  sessionId: string,                   // destinataire session id
  payload: {
    from: string,                      // 'human' | 'system' | sessionId source
    to: string,                        // sessionId | 'broadcast'
    fromOrchestratorId?: string,       // présent ssi cross-team
    fromSessionName?: string,
    fromOrchestratorName?: string,
  },
}
```

### 5.2 `useEvents` aujourd'hui — limitations

`hooks/useEvents.ts` ne *capture que* `session.status_changed → waiting`
pour les toasts (`useEvents.ts:109-130`). Tous les autres types de frames
sont **silencieusement ignorés** (le `else` du `try/catch` n'est jamais
atteint pour eux — le frame est juste parsé puis jeté).

**Décision Step 6** : on étend `useEvents` plutôt que d'ouvrir un second
WS. Deux options :

- **(a) callback subscription** : `useEvents({ onMailboxMessage: (ev) => … })`
  — pure subscriber, pas de re-render de tout l'arbre quand un pulse
  arrive, parfait pour un consumer impératif comme MapView qui pousse
  dans un state local "pulses".
- **(b) state additionnel `pulses: Pulse[]`** : moins propre car ce
  serait *MapView only* qui consomme — chaque re-render du hook trigger
  un re-render de tout ce qui appelle `useEvents`.

→ **Option (a) retenue**. Modification minimale de `useEvents.ts` :

```ts
// Patch useEvents.ts (additif, n'affecte pas l'existant `waiting`)
export interface UseEventsOptions {
  /** Callback fired on every mailbox.message frame received from the bus. */
  onMailboxMessage?: (ev: MailboxMessageEvent) => void;
}
export interface MailboxMessageEvent {
  kind: 'mailbox.message';
  ts: string;
  orchestratorId: string;
  sessionId: string;
  from: string;
  to: string;
  fromOrchestratorId?: string;
  fromOrchestratorName?: string;
  fromSessionName?: string;
}

export function useEvents(opts: UseEventsOptions = {}): {
  connected: boolean;
  waiting: WaitingNotice[];
  dismiss: (id: string) => void;
  clear: () => void;
} {
  // Mirror callback in a ref so the WS effect reads the fresh fn without
  // tearing down the socket on every parent render (same pattern as
  // useGlobalMessageStats).
  const onMailRef = useRef(opts.onMailboxMessage);
  useEffect(() => { onMailRef.current = opts.onMailboxMessage; },
            [opts.onMailboxMessage]);

  // … existing setup …

  ws.onmessage = (e) => {
    try {
      const ev = JSON.parse(typeof e.data === 'string' ? e.data : '') as SwarmEvent;

      if (ev.kind === 'mailbox.message') {
        const p = ev.payload as {
          from?: string; to?: string;
          fromOrchestratorId?: string;
          fromOrchestratorName?: string;
          fromSessionName?: string;
        } | undefined;
        if (p && ev.sessionId && ev.orchestratorId && p.from && p.to) {
          onMailRef.current?.({
            kind: 'mailbox.message',
            ts: ev.ts,
            orchestratorId: ev.orchestratorId,
            sessionId: ev.sessionId,
            from: p.from, to: p.to,
            fromOrchestratorId: p.fromOrchestratorId,
            fromOrchestratorName: p.fromOrchestratorName,
            fromSessionName: p.fromSessionName,
          });
        }
        // do NOT return — let the existing `session.status_changed` path
        // continue handling its frames.
      }

      // … existing waiting toast logic untouched …
    } catch { /* drop malformed frames */ }
  };
}
```

Validation à coder dans `useEvents.test.ts` : un frame `mailbox.message`
appelle le callback ; un frame malformé (missing `payload.from`) ne le
fait pas ; le frame `session.status_changed` continue de produire son
toast.

### 5.3 Dérivation du `kind` (4 cas, ordre testé)

Spec §3.3 / brief §1 — l'ordre **est** important (early-return) :

```ts
function deriveKind(ev: MailboxMessageEvent): MapPulse['kind'] {
  // 1) Broadcast operator/agent (`team.broadcast` → tous les workers).
  if (ev.to === 'broadcast') return 'broadcast';
  // 2) Cross-team : pulse vient d'un autre orchestrator.
  if (ev.fromOrchestratorId && ev.fromOrchestratorId !== ev.orchestratorId) {
    return 'cross';
  }
  // 3) Operator broadcast (`POST /orchestrators/:id/broadcast`).
  if (ev.from === 'human') return 'human';
  // 4) Intra-team peer-to-peer (`team.send_message`).
  return 'intra';
}
```

### 5.4 Résolution `from` / `to` en endpoints du pulse

Le pulse SVG voyage de `from` SessionId → `to` SessionId, ou
`'__center__'` pour traverser le hub. Convention héritée du proto
(`v2/map.jsx:351-368`) :

| `kind`      | `from`                                              | `to`                                          |
|-------------|-----------------------------------------------------|-----------------------------------------------|
| `intra`     | `ev.from` (sessionId du peer)                       | `ev.sessionId` (sessionId destinataire)       |
| `cross`     | `'__center__'`                                       | `ev.sessionId` (lead destinataire, via hub)   |
| `human`     | `'__center__'`                                       | `ev.sessionId`                                |
| `broadcast` | `'__center__'`                                       | `ev.sessionId` (un pulse par recipient)       |

Note : un `team.broadcast` génère **N events** côté serveur (un par
recipient, S2). Le client n'a donc pas à "fanouter" — il reçoit déjà N
frames distinctes, chacune émettant un pulse `broadcast` vers son
destinataire. Idem pour le hub-broadcast (operator → tous les leads).

### 5.5 Gestion cap 32 + dedupe 200ms

```ts
const PULSE_CAP = 32;
const PULSE_DEDUPE_MS = 200;

interface MapPulse {
  id: number;
  from: string;
  to: string;
  kind: 'intra' | 'cross' | 'human' | 'broadcast';
  ts: number;          // ms — utilisé pour le dedupe sliding window
}

function pushPulse(
  prev: readonly MapPulse[],
  next: Omit<MapPulse, 'id'>,
  nextId: () => number,
): MapPulse[] {
  // Dedupe: drop if a pulse with same (from, to, kind) was pushed in the
  // last PULSE_DEDUPE_MS. Walks backwards from the tail — bursts are
  // typically at the tail.
  const now = next.ts;
  for (let i = prev.length - 1; i >= 0; i--) {
    const p = prev[i];
    if (!p) break;
    if (now - p.ts > PULSE_DEDUPE_MS) break;          // sliding window
    if (p.from === next.from && p.to === next.to && p.kind === next.kind) {
      return prev as MapPulse[];                       // dropped (duplicate)
    }
  }
  const out = [...prev, { id: nextId(), ...next }];
  // Cap: keep the last PULSE_CAP only (oldest dropped).
  return out.length > PULSE_CAP ? out.slice(out.length - PULSE_CAP) : out;
}
```

**Cleanup différé** (port du proto `v2/app.jsx:257-263`) : un
`setTimeout` 1.5 s tronque le tableau à la dernière fenêtre `PULSE_CAP`,
de sorte que les pulses dont l'animation CSS est terminée ne restent pas
dans le DOM :

```ts
useEffect(() => {
  if (pulses.length === 0) return;
  const t = setTimeout(() => {
    setPulses((p) => p.slice(Math.max(0, p.length - PULSE_CAP)));
  }, 1500);
  return () => clearTimeout(t);
}, [pulses]);
```

Les `circle.pulse-dot` ont `animation: pulse-travel … forwards` (CSS
v2) — ils s'animent une fois puis restent figés à `offset-distance:
100%` (donc invisibles car le path se termine sur le destinataire).
React les nettoie au prochain rendu via la troncature.

## 6. Inbox badges (poll `peekInbox` 3s)

### 6.1 Pattern retenu : un `useEffect` global

Le composant `OrchestratorView.tsx` actuel a déjà la bonne implémentation
(`OrchestratorView.tsx:55-80`) : un seul `useEffect` qui fait `N` requêtes
parallèles à `peekInbox` toutes les 3 s pour les `N` sessions visibles, et
remplit une `Map<sessionId, number>`. **À porter** au niveau du
`DesktopShell` (ou directement dans `MapView`) :

```ts
// dans MapView.tsx ou DesktopShell.tsx
const [inboxCounts, setInboxCounts] = useState<Map<string, number>>(() => new Map());

useEffect(() => {
  let cancelled = false;
  async function pollAll() {
    // Snapshot des sessions actives au moment du tick (évite races si la
    // liste change pendant le poll).
    const tasks: Array<Promise<[string, number] | null>> = [];
    for (const o of orchestrators) {
      if (o.endedAt != null) continue;             // skip ended orchs
      for (const s of o.sessions) {
        if (
          s.status === 'exited' || s.status === 'killed' ||
          s.status === 'failed' || s.status === 'interrupted'
        ) continue;
        tasks.push(
          api.peekInbox(o.id, s.id)
            .then((r) => [s.id, r.count] as [string, number])
            .catch(() => null),
        );
      }
    }
    const results = await Promise.all(tasks);
    if (cancelled) return;
    const next = new Map<string, number>();
    for (const r of results) if (r) next.set(r[0], r[1]);
    setInboxCounts(next);
  }
  void pollAll();
  const id = setInterval(() => void pollAll(), 3000);
  return () => { cancelled = true; clearInterval(id); };
}, [orchestrators]);
```

**Pourquoi global plutôt qu'un poll par Node** :
- N requêtes parallèles dans un `Promise.all` = 1 round trip latency × 1
  (loopback) ; N `setInterval` séparés = N timers + N re-renders étalés.
- Une seule source de vérité (Map) pour le tooltip + le badge.
- Cancellation centralisée (`cancelled` flag) au unmount.

**Optimisation** : recréer le `setInterval` à chaque changement
d'`orchestrators` (3 s par défaut) **double** le rate. → Mieux : passer
`orchestrators` par ref pour ne pas re-init l'interval :

```ts
const orchRef = useRef(orchestrators);
useEffect(() => { orchRef.current = orchestrators; }, [orchestrators]);

useEffect(() => {
  // … utilise orchRef.current dans pollAll() …
}, []);   // mount/unmount only
```

Recommandé pour la version finale ; la version "simple" ci-dessus reste
acceptable v1 (les polls sont idempotents, le pire cas est un poll en
double quand l'orchestrators array change pile au moment du tick).

### 6.2 Propagation

`inboxCounts` est passé à `toMapViewTeams(orchestrators, now, inboxCounts)`
(§2.1). `toNodeAgent` y lit le count par session et le pose sur
`NodeAgent.inbox`. Le composant `Node` (déjà câblé Step 2) le rend en
badge `node-inbox-bg` + `node-inbox-txt` si > 0.

## 7. Spawn animation

Le proto utilise un `Set<string> spawningIds` passé à chaque Node ; quand
l'id est dedans, la classe CSS `.node.spawning` est ajoutée (animation
`.7s ease-out`).

Step 6 : on écoute l'event `session.created` (`useEvents` ne le surface
pas non plus aujourd'hui — même patch que §5.2, ajouter un callback
`onSessionCreated`). Alternative pragmatique : poller `useOrchestrators`
fait apparaître la session dans le snapshot suivant (au plus 3 s plus
tard) ; on peut déclencher la spawn anim au moment où on observe un
sessionId **nouveau** entre deux snapshots :

```ts
// dans MapView.tsx ou DesktopShell.tsx
const [spawningIds, setSpawningIds] = useState<Set<string>>(() => new Set());
const knownIdsRef = useRef<Set<string>>(new Set());

useEffect(() => {
  const cur = new Set<string>();
  for (const o of orchestrators)
    for (const s of o.sessions) cur.add(s.id);

  const fresh: string[] = [];
  for (const id of cur)
    if (!knownIdsRef.current.has(id)) fresh.push(id);

  // First snapshot: prime knownIds without firing anim (we don't want
  // every session to flash on initial load).
  if (knownIdsRef.current.size === 0) {
    knownIdsRef.current = cur;
    return;
  }
  knownIdsRef.current = cur;

  if (fresh.length === 0) return;
  setSpawningIds((prev) => {
    const next = new Set(prev);
    for (const id of fresh) next.add(id);
    return next;
  });
  // Remove after 700 ms (anim duration of v2 .node.spawning).
  const t = setTimeout(() => {
    setSpawningIds((prev) => {
      const next = new Set(prev);
      for (const id of fresh) next.delete(id);
      return next;
    });
  }, 700);
  return () => clearTimeout(t);
}, [orchestrators]);
```

**Pourquoi via polling diff plutôt qu'event `session.created`** :
- Robustesse : couvre aussi les sessions créées via MCP (`team.spawn_worker`
  côté lead) — pas seulement celles créées via `POST /orchestrators`.
- Moins de surface d'API à modifier (`useEvents` patch minimal).
- Latence acceptable : 0-3 s de délai à l'animation, ce qui est le
  pacing du proto (les "spawn" du proto étaient eux aussi groupés
  par interval).

**Si on veut la latence sub-second** : ajouter un second callback à
`useEvents` (`onSessionCreated`) en plus de `onMailboxMessage` (§5.2),
pattern identique. Step 6 minimaliste = on s'en passe.

## 8. Interactions (callbacks)

### 8.1 `onSelect` lifté à `DesktopShell`

D'après `docs/redesign-desktop/03_routes-desktop-shell.md`, `DesktopShell`
détient déjà :

```ts
const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
```

MapView reçoit `selectedId` + `onSelect: (id: string | null) => void`
(prop déjà déclarée dans le squelette Step 2). Câblage Step 6 :

```tsx
<MapView
  teams={mapTeams}
  selectedId={selectedSessionId}
  onSelect={setSelectedSessionId}
  onBroadcast={() => setShowBroadcast(true)}
  pulses={pulses}
  spawningIds={spawningIds}
/>
```

Cas d'usage :
- Clic sur un node (lead ou worker) → `onSelect(sessionId)` (Node →
  MapView passe déjà `(a) => onSelect(a.id)` au Step 2). RightPanel
  s'ouvre (selectedSessionId !== null).
- Clic sur le canvas vide → MapView appelle `onSelect(null)` →
  RightPanel se ferme.
- Le route hash `#/orchestrators/:id` pré-sélectionne le lead de
  l'orchestrator demandé via `route → setSelectedSessionId(leadSessionId)`
  (déjà fait au Step 3).

### 8.2 `onBroadcast` (hub click)

```tsx
const [showBroadcast, setShowBroadcast] = useState(false);
// MapView.onBroadcast = () => setShowBroadcast(true)
// BroadcastModal sera implémenté en Phase C (Step 12). Step 6 :
// `onBroadcast` est branché mais BroadcastModal reste un placeholder.
```

Le composant `BroadcastModal` (Phase C) itèrera
`api.broadcastToOrchestrator(orch.id, content)` sur les orchestrators
actifs (gap §4-1, workaround documenté).

### 8.3 Pan/zoom/pinch + reset (Step 2 — inchangé)

Tout est self-contained dans MapView (gestureRef + vb state + zoomAt +
onWheel/onPointer*). Step 6 ne touche pas à cette logique.

### 8.4 Tooltip hover (Step 2 — adaptation mineure)

`Node.onHover(agent, pos)` → `MapView.handleHover` met à jour `tip`
(local state). Vu que `agent.role` et `agent.status` sont maintenant des
**strings serveur** (pas mock), `statusLabel(agent.status)` (lib/format)
les normalise déjà ("RUNNING", "WAITING", "IDLE", "STARTING", "FAILED",
"EXITED", "KILLED", "INTERRUPTED", "PAUSED"). Pas de changement Step 6.

## 9. `MapView.tsx` final — diff vs squelette Step 2

Le squelette Step 2 est déjà presque correct. Step 6 n'ajoute **rien**
au corps du composant (pas de logique de data binding *interne* à
MapView : data dérivée + inbox poll + pulses + spawn live tous au niveau
`DesktopShell`). Le seul changement vraiment local : `Props.pulses`
devient une obligation logique (toujours fourni). Voici le composant
final, qui correspond exactement au squelette Step 2 modulo l'ajout de
`MapPulse` et `MapViewTeam` au-dessus :

```tsx
// packages/web/src/components/desktop/MapView.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  CENTER, VBW, VBH,
  layoutTeams,
  type MapTeam, type NodePosition,
} from './layoutTeams';
import Node, { type NodeAgent } from './Node';
import { curveBetween } from './curveBetween';
import { statusLabel } from '../../lib/format';

export interface MapViewTeam extends MapTeam {
  status: string;
  lead: NodeAgent;
  workers: NodeAgent[];
}

export interface MapPulse {
  id: number | string;
  from: string;     // sessionId OR '__center__'
  to: string;
  kind: 'intra' | 'cross' | 'human' | 'broadcast';
}

interface Props {
  teams: readonly MapViewTeam[];
  selectedId: string | null;
  onSelect: (sessionId: string | null) => void;
  onBroadcast: () => void;
  pulses: readonly MapPulse[];
  spawningIds: ReadonlySet<string>;
  showIntra?: boolean;
}

interface Tip {
  x: number; y: number;
  name: string; role: string; team?: string; status: string;
  inbox?: number;
}
interface ViewBox { x: number; y: number; w: number; h: number }

export default function MapView({
  teams, selectedId, onSelect, onBroadcast,
  pulses, spawningIds, showIntra = true,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [vb, setVb] = useState<ViewBox>({ x: 0, y: 0, w: VBW, h: VBH });
  const [panning, setPanning] = useState(false);

  const gestureRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    panStart: { vbX: number; vbY: number; px: number; py: number } | null;
    pinchStart: { dist: number; midSvg: { x: number; y: number }; vb: ViewBox } | null;
    didDrag: boolean;
  }>({ pointers: new Map(), panStart: null, pinchStart: null, didDrag: false });

  /* clientToSvg + zoomAt + wheel/pointer handlers : IDENTIQUES Step 2 */
  // … (cf. desktop/02_desktop-skeleton.md §3.8) …

  const positions = useMemo(() => layoutTeams(teams), [teams]);

  // Edges (lead↔hub, lead↔worker, intra-workers) — Step 2 inchangé.
  const leadLinks = useMemo(() => {
    const out: Array<{ a: typeof CENTER; b: NodePosition; teamId: string; status: string }> = [];
    teams.forEach((t) => {
      const lp = positions[t.lead.id];
      if (lp) out.push({ a: CENTER, b: lp, teamId: t.id, status: t.status });
    });
    return out;
  }, [teams, positions]);

  const teamEdges = useMemo(() => {
    const out: Array<{ a: NodePosition; b: NodePosition; teamId: string; status: string }> = [];
    teams.forEach((t) => {
      const lp = positions[t.lead.id]; if (!lp) return;
      t.workers.forEach((w) => {
        const wp = positions[w.id]; if (!wp) return;
        out.push({ a: lp, b: wp, teamId: t.id, status: t.status });
      });
    });
    return out;
  }, [teams, positions]);

  const intraEdges = useMemo(() => {
    const out: Array<{ a: NodePosition; b: NodePosition; teamId: string; status: string }> = [];
    teams.forEach((t) => {
      for (let i = 0; i < t.workers.length - 1; i++) {
        const w = t.workers[i]; const n = t.workers[i + 1];
        if (!w || !n) continue;
        const a = positions[w.id]; const b = positions[n.id];
        if (!a || !b) continue;
        out.push({ a, b, teamId: t.id, status: t.status });
      }
    });
    return out;
  }, [teams, positions]);

  const selectedTeamId = useMemo(() => {
    for (const t of teams) {
      if (t.lead.id === selectedId) return t.id;
      if (t.workers.some((w) => w.id === selectedId)) return t.id;
    }
    return null;
  }, [teams, selectedId]);

  function handleCanvasClick() {
    if (gestureRef.current.didDrag) { gestureRef.current.didDrag = false; return; }
    onSelect(null);
  }

  function handleHover(agent: NodeAgent | null, pos: NodePosition | null) {
    if (!agent || !pos) { setTip(null); return; }
    const teamId = positions[agent.id]?.teamId;
    const team = teams.find((t) => t.id === teamId);
    setTip({
      x: pos.x, y: pos.y,
      name: agent.name, role: agent.role, team: team?.id,
      status: statusLabel(agent.status), inbox: agent.inbox,
    });
  }

  return (
    <div
      className={`canvas-wrap ${panning ? 'panning' : ''}`}
      ref={wrapRef}
      onClick={handleCanvasClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="grid-bg" />
      <svg
        className="canvas-svg"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="hub-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%"  style={{ stopColor: 'var(--amber)', stopOpacity: 0.35 }} />
            <stop offset="60%" style={{ stopColor: 'var(--amber)', stopOpacity: 0.08 }} />
            <stop offset="100%" style={{ stopColor: 'var(--amber)', stopOpacity: 0 }} />
          </radialGradient>
        </defs>

        <circle cx={CENTER.x} cy={CENTER.y} r={420} fill="url(#hub-glow)" />

        <g>
          {leadLinks.map((e, i) => {
            const dim = selectedTeamId && e.teamId !== selectedTeamId;
            const stopped = e.status === 'stopped' || e.status === 'failed';
            const cls = `edge lead-link ${stopped ? 'stopped' : ''} ${dim ? 'dim' : ''} ${selectedTeamId === e.teamId ? 'highlight' : ''}`;
            return <path key={`L${i}`} className={cls} d={curveBetween(e.a, e.b, 0.04)} />;
          })}
          {teamEdges.map((e, i) => {
            const dim = selectedTeamId && e.teamId !== selectedTeamId;
            const stopped = e.status === 'stopped' || e.status === 'failed';
            const cls = `edge ${stopped ? 'stopped' : ''} ${dim ? 'dim' : ''} ${selectedTeamId === e.teamId ? 'highlight' : ''}`;
            return <path key={`T${i}`} className={cls} d={curveBetween(e.a, e.b, 0.10)} />;
          })}
          {showIntra && intraEdges.map((e, i) => {
            const dim = selectedTeamId && e.teamId !== selectedTeamId;
            const stopped = e.status === 'stopped' || e.status === 'failed';
            const cls = `edge intra ${stopped ? 'stopped' : ''} ${dim ? 'dim' : ''}`;
            return <path key={`I${i}`} className={cls} d={curveBetween(e.a, e.b, 0.30)} />;
          })}
        </g>

        <g>
          {pulses.map((p) => {
            const from = p.from === '__center__' ? CENTER : positions[p.from];
            const to   = p.to   === '__center__' ? CENTER : positions[p.to];
            if (!from || !to) return null;
            const kind = p.kind;
            const cls = `pulse-dot ${kind === 'human' ? 'human' : kind === 'broadcast' ? 'broadcast' : ''}`;
            const style: CSSProperties = {
              offsetPath: `path("${curveBetween(from, to, 0.10)}")`,
              animation: `pulse-travel ${kind === 'broadcast' ? '1800ms' : '1400ms'} linear forwards`,
            };
            return <circle key={p.id} className={cls} r={kind === 'broadcast' ? 2.8 : 2.4} style={style} />;
          })}
        </g>

        <g className="center-hub"
           onClick={(e) => { e.stopPropagation(); onBroadcast(); }}>
          <circle className="outer" cx={CENTER.x} cy={CENTER.y} r={42} />
          <circle className="outer" cx={CENTER.x} cy={CENTER.y} r={26} opacity="0.55" />
          <circle className="inner" cx={CENTER.x} cy={CENTER.y} r={10} />
          <text x={CENTER.x} y={CENTER.y + 62}>SWARM // BUS</text>
          <text x={CENTER.x} y={CENTER.y + 76} opacity="0.6">
            click :: broadcast to all leads
          </text>
        </g>

        <g>
          {teams.map((team) => {
            const lp = positions[team.lead.id];
            if (!lp) return null;
            return (
              <g key={team.id}>
                <Node
                  agent={team.lead}
                  pos={lp}
                  isLead
                  selected={selectedId === team.lead.id}
                  spawning={spawningIds.has(team.lead.id)}
                  onClick={(a) => onSelect(a.id)}
                  onHover={handleHover}
                />
                {team.workers.map((w) => {
                  const wp = positions[w.id]; if (!wp) return null;
                  return (
                    <Node
                      key={w.id}
                      agent={w}
                      pos={wp}
                      selected={selectedId === w.id}
                      spawning={spawningIds.has(w.id)}
                      onClick={(a) => onSelect(a.id)}
                      onHover={handleHover}
                    />
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>

      {tip && (
        <div className="canvas-tooltip" style={tooltipStyle(tip, wrapRef.current, vb)}>
          {tip.name}
          <div className="sub">
            {tip.team} :: {tip.role} :: {tip.status}
            {tip.inbox !== undefined && tip.inbox > 0 && (
              <span style={{ color: 'var(--amber)' }}> · INBOX {tip.inbox}</span>
            )}
          </div>
        </div>
      )}

      <div className="canvas-hud">
        <span><span className="k">FRAME</span> :: SWARM-MAP/02</span>
        <span><span className="k">ZOOM</span> :: {(VBW / vb.w).toFixed(2)}x</span>
        <span><span className="k">VIEW</span> :: ORBIT</span>
      </div>
      <div className="canvas-zoom">
        <button title="zoom out"
          onClick={(e) => { e.stopPropagation(); zoomAt({ x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, 1.18); }}>−</button>
        <button title="reset"
          onClick={(e) => { e.stopPropagation(); setVb({ x: 0, y: 0, w: VBW, h: VBH }); }}>◇</button>
        <button title="zoom in"
          onClick={(e) => { e.stopPropagation(); zoomAt({ x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 }, 1 / 1.18); }}>+</button>
      </div>
    </div>
  );
}
```

(le helper `tooltipStyle` est exactement celui livré au Step 2, §3.8)

### 9.1 Wiring depuis `DesktopShell.tsx`

C'est **ici** que la totalité de la binding logic vit. Pseudo-code :

```tsx
function DesktopShell() {
  const { orchestrators } = useOrchestrators(3000);
  const now = useNow(1000);                                // 1 s for crisp idle / SVR-RESTART
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showBroadcast, setShowBroadcast] = useState(false);

  // §6 — Inbox poll (3 s)
  const orchRef = useRef(orchestrators);
  useEffect(() => { orchRef.current = orchestrators; }, [orchestrators]);
  const [inboxCounts, setInboxCounts] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    async function pollAll() { /* see §6.1 */ }
    void pollAll();
    const id = setInterval(() => void pollAll(), 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // §7 — Spawn anim (diff polling, 700 ms removal)
  const [spawningIds, setSpawningIds] = useState<Set<string>>(() => new Set());
  /* see §7 */

  // §5 — Pulses (mailbox.message → MapPulse)
  const [pulses, setPulses] = useState<MapPulse[]>([]);
  const pulseIdRef = useRef(1);
  useEvents({
    onMailboxMessage: (ev) => {
      const kind = deriveKind(ev);
      const from = (kind === 'intra') ? ev.from : '__center__';
      const to   = ev.sessionId;
      setPulses((prev) =>
        pushPulse(prev, { from, to, kind, ts: Date.now() }, () => pulseIdRef.current++)
      );
    },
  });
  useEffect(() => {
    if (pulses.length === 0) return;
    const t = setTimeout(() => {
      setPulses((p) => p.slice(Math.max(0, p.length - PULSE_CAP)));
    }, 1500);
    return () => clearTimeout(t);
  }, [pulses]);

  // §2 — Derived MapViewTeam[]
  const mapTeams = useMemo(
    () => toMapViewTeams(orchestrators, now, inboxCounts),
    [orchestrators, now, inboxCounts],
  );

  return (
    <div className="desktop-shell">
      <TopBar … />
      <LeftPanel … />
      <MapView
        teams={mapTeams}
        selectedId={selectedSessionId}
        onSelect={setSelectedSessionId}
        onBroadcast={() => setShowBroadcast(true)}
        pulses={pulses}
        spawningIds={spawningIds}
      />
      <RightPanel sessionId={selectedSessionId} … />
      {showBroadcast && <BroadcastModal onClose={() => setShowBroadcast(false)} />}
    </div>
  );
}
```

## 10. Performance

### 10.1 Throttle / dedupe pulses

- **Dedupe 200 ms** : §5.5 (`PULSE_DEDUPE_MS`). Évite la sur-densité quand
  un `team.broadcast(N)` génère N events dans la même milliseconde.
- **Cap 32** : `slice(Math.max(0, p.length - 32))`. Si on déborde, on
  perd les pulses les plus *anciens* — ils ont déjà fini de s'animer
  (anim 1.4 s, cap 32 ⇒ tolère ~22 messages/s soutenus).
- **Cleanup différé** : `setTimeout(1500)` qui trunc à la dernière
  fenêtre (mêmes 32, mais on libère le DOM des pulses morts ; `forwards`
  les garde sinon en place).

### 10.2 Mémoisation

- `positions = useMemo(() => layoutTeams(teams), [teams])` — déjà
  Step 2.
- `leadLinks` / `teamEdges` / `intraEdges` / `selectedTeamId` → `useMemo`
  ajoutés en Step 6 (voir §9). Économisent un O(N) sur chaque re-render
  déclenché par `setPulses` (≥ 1×/s en utilisation soutenue).
- `mapTeams = useMemo(toMapViewTeams(…), [orchestrators, now, inboxCounts])`.
  **Attention** : `now` (5 s default de `useNow`) change toutes les 5 s ;
  recommandé d'utiliser `useNow(1000)` ici car `enrichWithIdle` a un
  seuil à 30 s — 1 s de précision suffit pour basculer running↔idle
  visuellement. Avec 1 s, on rebuild `mapTeams` une fois par seconde,
  ce qui force un re-render de `MapView` ; le coût est dominé par
  `layoutTeams` (O(N)) et `Node × M` rendu (déjà mémoisé par React
  diffing).
- **`React.memo(Node)`** : à ajouter si le nombre de nodes dépasse ~30.
  Le pattern `agent` est immuable par re-derivation (chaque tick produit
  un nouvel objet → memo cassé). Si besoin, comparer manuellement les
  champs primitifs :
  ```ts
  export default React.memo(Node, (a, b) =>
    a.agent.id === b.agent.id &&
    a.agent.status === b.agent.status &&
    a.agent.inbox === b.agent.inbox &&
    a.isLead === b.isLead &&
    a.selected === b.selected &&
    a.spawning === b.spawning &&
    a.pos.x === b.pos.x && a.pos.y === b.pos.y
  );
  ```
  Non bloquant v1. À ajouter si le perf-budget chute.

### 10.3 Cap noeuds

Le proto ne plafonne pas le nombre de teams ; la formule
`angle = (i / N) * 2π - π/2` accepte N arbitraire mais devient illisible
au-delà de ~10 teams (les leads se chevauchent à `LEAD_RADIUS=320` /
`WORKER_RADIUS=150` dans une zone 1200×900). À documenter mais sans cap
explicite v1 — l'opérateur a la main sur le nombre de teams.

### 10.4 Coût `Promise.all(peekInbox × N)` toutes les 3 s

Pour 10 teams × 5 sessions = 50 requêtes / 3 s = ~17 RPS. Loopback,
négligeable. Si jamais on monte à 100 sessions : passer à un endpoint
batch `GET /orchestrators/inboxes` (gap potentiel à spec si besoin).

## 11. Plan d'implémentation pas-à-pas

1. **Patch `useEvents`** (§5.2). Ajouter `UseEventsOptions` +
   `MailboxMessageEvent` + callback `onMailboxMessage`. Tester
   l'invariant : un frame `mailbox.message` appelle le callback ; un
   frame `session.status_changed` continue de surfacer un toast.
   *Critère* : `useEvents.test.ts` passe avec un nouveau test
   `triggers onMailboxMessage on mailbox.message frame`.

2. **Ajouter `desktop/mapTeams.ts`** (helper `toMapViewTeams` + helper
   `toNodeAgent` + constante `TAU`). Cf. §2.1. Unit test pur :
   inputs synthétiques `OrchestratorView[]` → outputs `MapViewTeam[]`
   avec angles `-π/2`, `0`, `π/2`, `π` pour N=4.

3. **Ajouter `desktop/pulses.ts`** : `MapPulse`, `deriveKind`,
   `pushPulse`, `PULSE_CAP`, `PULSE_DEDUPE_MS`. Cf. §5.3-5.5. Unit
   tests :
   - dedupe 200 ms drop le doublon ;
   - cap 32 trim le plus ancien ;
   - `deriveKind` couvre les 4 cas (broadcast / cross / human / intra).

4. **Étendre `MapView.tsx`** : promouvoir `pulses` + `spawningIds` en
   props non-optionnelles, ajouter les `useMemo` pour
   `leadLinks/teamEdges/intraEdges/selectedTeamId`. Tout le reste du
   composant reste celui du Step 2. Pas de breaking change pour les
   consommateurs (les props existent déjà).

5. **Étendre `DesktopShell.tsx`** : voir §9.1. Ajouts :
   - state `inboxCounts` + effect poll 3 s ;
   - state `spawningIds` + effect diff polling + cleanup 700 ms ;
   - state `pulses` + `useEvents({ onMailboxMessage })` + cleanup
     1.5 s ;
   - state `showBroadcast` ;
   - dérivation `mapTeams = useMemo(toMapViewTeams(…), …)` ;
   - branchement de toutes les props sur `<MapView />`.

6. **CSS** : vérifier dans `desktop-theme.css` (Step 1) que les
   classes utilisées par le data binding existent :
   - `.node-inbox-bg`, `.node-inbox-txt` (badge inbox)
   - `.node-ring-pulse` (waiting amber pulse)
   - `.node-svr-restart` (label `STARTING` / `SVR-RESTART`)
   - `.node.spawning` (anim 700 ms ease-out)
   - `.pulse-dot`, `.pulse-dot.human`, `.pulse-dot.broadcast`
   - `@keyframes pulse-travel`
   - `.center-hub` (cursor pointer + glow on hover)
   - `.canvas-tooltip` (positionnement absolu)
   Si absentes, les ajouter (extraites du `<style>` de
   `prototypes/v2/Swarm OS v2.html`).

7. **Smoke test manuel** (§12).

8. **Cleanup** : ne pas oublier de supprimer le placeholder
   `<main>MapView TODO</main>` dans `DesktopShell` Step 3.

## 12. Tests de fumée

À exécuter après docker rebuild (cf. memory : `docker build -t
swarm-os:latest . && docker compose -f docker-compose.test.yml up -d`) :

| # | Geste | Attendu |
|---|-------|---------|
| 1 | Créer un orchestrator `ATLAS` (role RESEARCHER, 2 workers) via NewTeam | Lead diamond + 2 workers circle apparaissent en orbite à `angle = -π/2` (12h). Spawn animation 700 ms visible. |
| 2 | Créer un 2e orchestrator `FORGE` (role BUILDER, 1 worker) | Les 2 leads se redistribuent à `(-π/2)` et `(π/2)` (6h et 12h). Worker triangle apparaît sous le lead FORGE. |
| 3 | Envoyer un message intra-team (lead ATLAS → SCOUT-01 via `team.send_message` MCP) | Pulse blanc (intra) voyage du lead vers le worker en ~1.4 s. |
| 4 | Cliquer le hub central | Modal `BroadcastModal` s'ouvre (placeholder en Phase B, vrai en Phase C). |
| 5 | Operator broadcast à ATLAS via `POST /orchestrators/atlas/broadcast` | N pulses `human` voyage du hub vers chaque session ATLAS. |
| 6 | Cross-team `swarm.send_to_lead` de FORGE → ATLAS | Pulse `cross` (couleur distincte) voyage du hub vers le lead ATLAS. |
| 7 | Marquer une session waiting (input pending via prompt confirm) | Ring `node-ring-pulse` ambre pulsant sur le node + dot status `ffb060`. |
| 8 | Laisser une session running silencieuse > 30 s | Status dot → `b6a48b` (idle), label `IDLE` dans tooltip. |
| 9 | Restart-server → reconnect | Sessions repassent `interrupted` → label `·· SVR-RESTART ··` sous le node. |
| 10 | Envoyer messages à une session via inbox (peer-to-peer) | Badge `node-inbox-bg` apparaît avec le count, mis à jour au plus 3 s plus tard. |
| 11 | Cliquer un worker | RightPanel s'ouvre (selectedSessionId !== null), MapView highlight la team (ring `selected`). |
| 12 | Cliquer le canvas vide | RightPanel se ferme, ring `selected` disparaît. |
| 13 | Spam `team.broadcast(10×)` en < 200 ms | Pulses dédupliqués (cap 32 + dedupe 200 ms). |
| 14 | Pan + zoom + reset bouton ◇ | `vb` change, reset revient à `{0,0,1200,900}`. |
| 15 | Stopper un worker (`stopSession`) | Ring → `stopped` (gris foncé), shape `fill='#3a3128'`, edge `stopped` (gris). |
| 16 | Tuer un orchestrator → status `failed` | Ring `failed` rouge, dot `e0654a`. |
| 17 | Unmount/remount (`#/` ↔ `#/roles`) | Pas de leak WS (vérifier console : pas de "duplicate connection" warning — corrige déjà par commit `584d9ec`). |

### 12.1 Tests unitaires à ajouter

- `desktop/mapTeams.test.ts` : `toMapViewTeams` :
  - skip les orchs sans `leadSessionId` ;
  - calcule les bons angles pour N=1, 2, 4 ;
  - mappe `s.role` → shape via `ROLE_SHAPE` ;
  - applique `enrichWithIdle` (mock now + lastActivityAt) ;
  - injecte le bon `inbox` count depuis la Map.
- `desktop/pulses.test.ts` : `pushPulse` :
  - cap 32 enforcement ;
  - dedupe 200 ms (même from/to/kind dans la fenêtre) ;
  - id unique monotone ;
  - `deriveKind` couverture 4 cas + ordre des early-returns.
- `useEvents.test.ts` : nouveau test `mailbox.message → callback`,
  invariant `waiting toast still fires`.

---

## Annexe — Récapitulatif des fichiers touchés

| Fichier | Type | Origine |
|---|---|---|
| `packages/web/src/components/desktop/MapView.tsx` | **modifié** | étend props (`pulses`, `spawningIds` non-optional) + `useMemo` edges |
| `packages/web/src/components/desktop/DesktopShell.tsx` | **modifié** | ajoute states `inboxCounts`, `spawningIds`, `pulses`, `showBroadcast`, dérive `mapTeams`, branche `useEvents({ onMailboxMessage })` |
| `packages/web/src/components/desktop/mapTeams.ts` | **nouveau** | `toMapViewTeams`, `toNodeAgent` |
| `packages/web/src/components/desktop/pulses.ts` | **nouveau** | `MapPulse`, `deriveKind`, `pushPulse`, `PULSE_CAP`, `PULSE_DEDUPE_MS` |
| `packages/web/src/hooks/useEvents.ts` | **modifié** | ajout `UseEventsOptions.onMailboxMessage` + `MailboxMessageEvent` |
| `packages/web/src/hooks/useEvents.test.ts` | **modifié** | nouveau test mailbox.message |
| `packages/web/src/components/desktop/mapTeams.test.ts` | **nouveau** | unit tests dérivation |
| `packages/web/src/components/desktop/pulses.test.ts` | **nouveau** | unit tests pulses |
| `packages/web/src/styles/desktop-theme.css` | **vérification** | s'assurer que toutes les classes du §11.6 existent |

Aucun changement serveur. Tous les endpoints requis (`peekInbox`,
`mailbox.message` event, `OrchestratorView.sessions`, `SessionView.role`,
`SessionView.type`, `lastActivityAt`) sont déjà livrés (S1-S12).
