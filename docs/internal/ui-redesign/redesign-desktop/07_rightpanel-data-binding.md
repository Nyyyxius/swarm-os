# Step 7 (Phase B.7) — Brancher `RightPanel` aux vraies données

> Lié au plan global `docs/internal/ui-redesign/ui-redesign-desktop.md` §3.4 (RightPanel mapping),
> §4 (gaps 2/3/4/5/6/8), §5.1 step 7. Pré-requis : Step 2 (squelette
> `desktop/RightPanel.tsx`, `desktop/ConfigTab.tsx`, `desktop/Composer.tsx`,
> `desktop/ConfirmModal.tsx`), Step 3 (lift `selectedSessionId` dans
> `DesktopShell`), Step 6 (`useOrchestrators` + map `inboxCounts` déjà
> branchés au shell). La source de vérité reste `prototypes/v2/panels.jsx`
> lignes 158-557.
>
> Ce step est le plus chargé de la Phase B — il câble simultanément :
> head/cfgline/cwd/stats/meta, 5 boutons d'action (avec ConfirmModal),
> 3 tabs (CONSOLE/MESSAGES/CONFIG) et le Composer (toggles PTY/INBOX +
> AGENT/TEAM). On ne touche pas au CSS (livré en Step 1) ni aux composants
> portés en Step 2 — on les **alimente** depuis `DesktopShell` (qui devient
> le hub d'orchestration). Aucune modification serveur.

---

## 1. Objectif

Remplacer les `RightPanelAgent | null`, `RightPanelTeam | null` et
`MessageBubble[]` que `DesktopShell.tsx` passe en placeholders (Step 2) par
des vraies données :

- `selected` = `useSession(selectedSessionId)` enrichi (load `undefined`,
  logLines depuis Terminal, writer depuis hello frame WS).
- `team`  = `orchestrators.find(o => o.id === selected.orchestratorId)`
  + `getRole(roleId)` pour `leadPrompt`, `connectors` (Discord).
- `messages` = `peekInbox(orchestratorId, sessionId)` poll 3 s, classifié
  par `classifyBubble` (S12).
- Tab CONSOLE = montage `Terminal.tsx` (xterm.js) avec
  `theme.background = '#0d0a08'` et hook callback pour remonter
  `writer/reader` + `logLines` au RightPanel.
- 5 actions câblées sur `api.stopSession / pauseSession / resumeSession /
  restartSession / destroyOrchestrator`, avec dispatch lead vs worker et
  `ConfirmModal` pour KILL/STOP.
- Composer câblé sur `api.postSessionInput` (PTY) ou
  `api.broadcastToOrchestrator` (TEAM) ; toggle INBOX désactivé v1
  (gap §4-5).

Aucune création de composant — tout se passe dans `DesktopShell.tsx` et
`RightPanel.tsx` (+ une retouche `Terminal.tsx` pour le theme + callbacks).

---

## 2. Données nécessaires — par section

### 2.1 Head (pr-head, lignes 232-298 du proto)

| Champ v2 | Source backend | Helper |
|---|---|---|
| `team.name` (pr-id) | `OrchestratorView.name` | — |
| `isLead ? 'LEAD' : 'WORKER'` | `selectedSessionId === orch.leadSessionId` | — |
| `selected.id.toUpperCase()` (pr-id suffix) | `SessionView.id` | `.toUpperCase()` |
| `selected.name` | `SessionView.name` | — |
| `chip status` + `dot` | `SessionView.status` | `statusChipClass(status)` + `statusLabel(status)` (lib/format.ts, livré Step 2) ; alternativement `mapSessionStatusToVisual` (S3) si on veut le bucket 5-couleurs |
| `selected.role` (pr-role) | `SessionView.role` | — |
| chip `◇ DISCORD` (hasDiscord) | `getRole(orch.roleId).connectors[].some(c => c.type === 'discord')` | dérivé client |

**Note** : `statusChipClass` produit 6 classes warm-black (`ok/warn/bad/
stopped/waiting/starting`). `mapSessionStatusToVisual` (S3) produit 5
buckets Tailwind. Pour le **chip warm-black** du proto on utilise
`statusChipClass` (l'objectif du Step 2 §5.4 garde-fou #2 — "ne pas
fusionner ces deux helpers"). `mapSessionStatusToVisual` reste réservé à
MapView et au `StatusBadge` legacy.

### 2.2 Cfgline (M:opus E:high P:default + edit)

| Champ v2 | Source backend |
|---|---|
| `team.model` (avec `.replace('claude-', '')`) | `OrchestratorView.defaultModel` |
| `team.effort` | `OrchestratorView.defaultEffort` |
| `team.permissionMode` (`color: warn si bypassPermissions`) | `OrchestratorView.defaultPermissionMode` |
| Bouton edit pencil → `onEditConfig(team)` | gap §4-2 — `EditConfigDialog` en preview disabled (Phase C13) ; le bouton ouvre quand même la modale mais elle affiche un avertissement "not available v1" |

### 2.3 Cwd

| Champ v2 | Source backend |
|---|---|
| `team.cwd` (pr-cwd) | `SessionView.cwd` du lead (puisque chaque session du backend porte son propre cwd, et le cwd "team" v2 = celui du lead) |

**Décision** : le proto stocke `cwd` sur la team (au niveau orch). Côté
serveur, `cwd` est sur chaque `SessionView`. Pour le RightPanel on affiche
**le cwd de la session sélectionnée** (`selected.cwd`) — c'est l'info la
plus pertinente quand on inspecte un worker dont le cwd peut diverger. Le
proto v2 ne distingue pas mais on est plus précis.

### 2.4 Stats (LOAD / UPTIME / LOG LINES)

| Cell | Source | Helper |
|---|---|---|
| LOAD | `undefined` (jamais exposé serveur, gap S10 by-design) | `formatLoadPercent(undefined)` → `'—'` (`lib/loadPercent.ts`) |
| UPTIME | `SessionView.startedAt` | `formatUptime(startedAt)` (`lib/format.ts`, livré Step 2) — renvoie `'HH:MM:SS'` |
| LOG LINES | compteur accumulé localement à partir des frames `{type:'data'}` du WS `/ws/sessions/:id` | callback `onLogLines(n)` remonté par `Terminal.tsx` (cf. §4.2 ci-dessous) |

Si `stopped` ou `isFailed` → LOAD et UPTIME affichent `'—'` (cf. JSX du
proto ligne 279/283 : `stopped ? '—' : ...`). LOG LINES reste affiché (la
valeur accumulée depuis le dernier reset du composant).

### 2.5 Meta (pid · started · last_activity)

| Champ v2 | Source backend | Helper |
|---|---|---|
| `pid` | `SessionView.pid` | display brut, fallback `'—'` |
| `started` | `SessionView.startedAt` | `formatClockShort(startedAt)` → `'HH:MM'` |
| `last_activity` | `SessionView.lastActivityAt` | `formatRelative(lastActivityAt)` → `'Ns ago'` |

Le re-render périodique est assuré par `useNow(5000)` au niveau
`DesktopShell` (déjà importé en Step 6) — `formatRelative` est re-calculé
à chaque tick.

### 2.6 Actions

Cf. §5 ci-dessous (5 boutons + leur dispatch).

### 2.7 Tabs

- **CONSOLE** : monte `Terminal.tsx` avec `sessionId={selected.id}` ;
  callback `onHello({role: 'writer'|'reader'})` pour la pastille
  WRITER/READER ; callback `onLogLines(n)` pour le compteur.
- **MESSAGES** : `messages: MessageBubble[]` (déjà classifiés par
  `classifyBubble` dans `DesktopShell`).
- **CONFIG** : alimente `ConfigTab` avec `RightPanelTeam` +
  `RightPanelAgent` (cf. §6).

### 2.8 Composer

Cf. §6 ci-dessous (toggles, dispatch).

---

## 3. Adapter logic — head/cfg/meta formatting

### 3.1 `buildRightPanelTeam(orch, role)` — dérivation team

À placer dans `DesktopShell.tsx` (ou extrait en
`desktop/rightPanelAdapters.ts` si on veut tester séparément). Pure
function — pas de hook.

```ts
import { type OrchestratorView, type RoleView } from '../../api/client';
import { type RightPanelTeam } from './RightPanel';

/**
 * Build the `RightPanelTeam` consumed by RightPanel from a raw
 * OrchestratorView + its role definition. The role is needed for
 * `leadPrompt` (orch only stores its overrides, the canonical prompt
 * lives on the role) and `connectors` (Discord webhook chip).
 *
 * `role` can be `null` if the orchestrator was created with a free-form
 * `role` string instead of a `roleId` — in that case `leadPrompt` is
 * `null` (the prompt was inlined into the lead's PTY at start time) and
 * `discordWebhook` is `null`.
 */
export function buildRightPanelTeam(
  orch: OrchestratorView,
  role: RoleView | null,
  leadCwd: string,
): RightPanelTeam {
  // Discord chip : derived from role.connectors. Multiple Discord
  // webhooks per role aren't supported by the UI v1 (only one chip is
  // rendered) — we take the first one if there are several.
  const discordWebhook = role?.connectors.find(
    (c) => c.type === 'discord',
  )?.webhookUrl ?? null;

  return {
    id: orch.id,
    name: orch.name,
    leadId: orch.leadSessionId ?? '',
    workerCount: orch.sessions.filter((s) => s.type === 'worker').length,
    model: orch.defaultModel,
    effort: orch.defaultEffort,
    permissionMode: orch.defaultPermissionMode,
    cwd: leadCwd,
    leadPrompt: role?.leadPrompt ?? null,
    leadPreamble: orch.leadPreamble,
    workerPreamble: orch.workerPreamble,
    discordWebhook,
  };
}
```

### 3.2 `buildRightPanelAgent(session, logLines, writer)` — dérivation agent

```ts
import { type SessionView } from '../../api/client';
import { type RightPanelAgent } from './RightPanel';

export function buildRightPanelAgent(
  session: SessionView,
  logLines: number,
  writer: boolean | undefined,
): RightPanelAgent {
  return {
    id: session.id,
    name: session.name,
    role: session.role,
    status: session.status,
    pid: session.pid,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    // S10 by-design : pas de signal `load` côté serveur. `undefined` →
    // formatLoadPercent renvoie '—'. NE PAS inventer de valeur.
    load: undefined,
    logLines,
    writer,
    // exitCode + stopReason propagés via ConfigTab (cf. §7.4).
  };
}
```

> Le squelette Step 2 expose `RightPanelAgent.load?: number` et
> `RightPanelAgent.writer?: boolean`. Si on étend `RightPanelAgent` avec
> `exitCode?: number | null` et `stopReason?: string | null` pour la
> section EXIT REASON du CONFIG, alors `ConfigTabAgent` (cf. §7.4)
> consomme ces deux champs aussi. Recommandation : étendre l'interface
> dans `RightPanel.tsx` plutôt que dupliquer.

### 3.3 Helpers de formatage — `lib/format.ts` (déjà livré Step 2)

| Helper | Signature | Usage RightPanel |
|---|---|---|
| `formatUptime(ts)` | `(number\|string\|null\|undefined) → 'HH:MM:SS'\|'—'` | pr-stats UPTIME cell |
| `formatRelative(ts)` | `(number\|string) → 'Ns ago'\|...\|'—'` | pr-meta `last_activity` |
| `formatClockShort(ts)` | `(number\|string) → 'HH:MM'\|'—'` | pr-meta `started`, ConfigTab STARTED |
| `statusLabel(s)` | `(string) → 'RUNNING'\|...` | head chip label |
| `statusChipClass(s)` | `(string) → 'ok'\|'warn'\|'bad'\|'stopped'\|'waiting'\|'starting'` | head chip class |
| `formatLoadPercent(v)` | `(number\|null\|undefined) → 'XX%'\|'—'` | pr-stats LOAD cell (depuis `lib/loadPercent.ts`, S10) |

---

## 4. Wiring data au `DesktopShell` — sources et états

### 4.1 États à ajouter dans `DesktopShell.tsx`

```ts
// Step 7 — états du RightPanel.

const { orchestrators } = useOrchestrators();             // déjà Step 4
const { roles } = useRoles();                              // nouveau Step 7
const { session: selectedSession } = useSession(selectedSessionId);

// inbox bubbles (3 s, polled in same effect as MapView inbox counts to
// avoid two parallel pollers on the same /inbox endpoint — see §4.4).
const [inboxMessages, setInboxMessages] = useState<MailMessageView[]>([]);

// Log line counter accumulated from Terminal.tsx hello/data frames.
const [logLines, setLogLines] = useState(0);
const [writer, setWriter] = useState<boolean | undefined>(undefined);

// Reset log counter when changing session.
useEffect(() => {
  setLogLines(0);
  setWriter(undefined);
  setInboxMessages([]);
}, [selectedSessionId]);

// Active tab persisted across the lifetime of the shell.
const [activeTab, setActiveTab] = useState<RightPanelTab>('console');
```

### 4.2 Callback Terminal → RightPanel (writer + logLines)

`Terminal.tsx` est déjà capable de détecter le rôle WRITER/READER via le
hello frame (cf. lignes 82-86 — `case 'attached'` / `case 'role-changed'`).
On l'augmente pour remonter l'info au parent + compter les frames `data`.

**Modification minimale à `Terminal.tsx`** (à faire dans la même PR Step 7) :

```ts
interface Props {
  sessionId: string;
  // Optional callbacks — RightPanel uses them; legacy callers (none in
  // v2 since OrchestratorView is going away in Step 3) leave them undefined.
  onRoleChange?: (role: 'writer' | 'reader') => void;
  onDataFrame?: () => void;
}

// dans onmessage :
case 'attached':
case 'role-changed':
  if (o.role === 'writer' || o.role === 'reader') {
    setRole(o.role);
    props.onRoleChange?.(o.role);
  }
  return;
case 'data':
  if (typeof o.data === 'string') {
    term.write(o.data);
    // Coarse log-line counter : 1 newline = 1 line. Cheap, no parsing.
    const nl = (o.data.match(/\n/g) ?? []).length;
    if (nl > 0) props.onDataFrame?.();   // RightPanel accumulates
  }
  return;
```

**Compteur côté DesktopShell** :

```ts
// L'incrément est passé par lots (1 par frame) pour ne pas surcharger
// React avec un setState par byte. Si volume très élevé, throttle à
// 500 ms.
const onTerminalDataFrame = useCallback(() => {
  setLogLines((n) => n + 1);            // approximation : 1 frame ≈ 1 line
}, []);
const onTerminalRoleChange = useCallback((r: 'writer' | 'reader') => {
  setWriter(r === 'writer');
}, []);
```

> **Alternative plus précise** : `setLogLines((n) => n + countNewlines)`.
> Pour Step 7, l'approximation suffit — la cellule LOG LINES est indicative
> ("ordre de grandeur d'activité"), pas un compteur transactionnel.

**Décision sur le theme xterm** : changer la ligne 41 de `Terminal.tsx` de
`theme: { background: '#0b1220' }` à `theme: { background: '#0d0a08' }`
(cf. §5.4 du plan global et `BACKDROPS.void` dans `v2/app.jsx:23`).
Conséquence : un seul caller (OrchestratorView, qui disparaît en Step 3)
voit le changement avant le port complet. Acceptable.

### 4.3 Récupération de la team et du role pour `selected`

```ts
// Une fois selectedSession arrivé (poll 2s via useSession), retrouver l'orch
// et le role pour construire les structures consommées par le RightPanel.
const selectedOrch = useMemo(
  () => orchestrators.find((o) => o.id === selectedSession?.orchestratorId) ?? null,
  [orchestrators, selectedSession?.orchestratorId],
);
const selectedRole = useMemo(
  () => roles.find((r) => r.id === selectedOrch?.roleId) ?? null,
  [roles, selectedOrch?.roleId],
);

const isLead = selectedSession?.id === selectedOrch?.leadSessionId;

const rightPanelTeam: RightPanelTeam | null = useMemo(() => {
  if (!selectedOrch || !selectedSession) return null;
  return buildRightPanelTeam(selectedOrch, selectedRole, selectedSession.cwd);
}, [selectedOrch, selectedRole, selectedSession]);

const rightPanelAgent: RightPanelAgent | null = useMemo(() => {
  if (!selectedSession) return null;
  return buildRightPanelAgent(selectedSession, logLines, writer);
}, [selectedSession, logLines, writer]);
```

### 4.4 Inbox messages (tab MESSAGES) — polling + classification

```ts
import { classifyBubble } from '../../lib/mailBubble';
import { type MailMessageView } from '../../api/client';

// Poll the selected session's inbox every 3 s. Re-uses the same /inbox
// endpoint as the MapView badge poller, but we don't share the state :
// MapView wants `count` per session (for the badge), RightPanel wants
// the full messages array for the active session only. Two pollers, OK.

useEffect(() => {
  if (!selectedSession || !selectedOrch) return;
  let cancelled = false;
  async function poll() {
    try {
      const r = await api.peekInbox(selectedOrch!.id, selectedSession!.id);
      if (!cancelled) setInboxMessages(r.messages);
    } catch {
      /* swallow — session may have been destroyed */
    }
  }
  void poll();
  const t = setInterval(() => void poll(), 3000);
  return () => {
    cancelled = true;
    clearInterval(t);
  };
}, [selectedOrch?.id, selectedSession?.id]);

const messageBubbles: MessageBubble[] = useMemo(() => {
  if (!selectedSession) return [];
  return inboxMessages.map((m): MessageBubble => {
    const cls = classifyBubble(m, selectedSession.id);
    return {
      from: cls.kind,                       // 'me' | 'them' | 'system' | 'other-team'
      who: cls.authorLabel,
      text: m.content,
      ts: m.ts,
      via: cls.fromTeam?.name,              // cross-team only — render "· via Atlas"
    };
  });
}, [inboxMessages, selectedSession?.id]);
```

**Notes** :
- `peekInbox` est non-destructive — le polling ne consomme rien côté
  serveur, c'est juste un read.
- L'ordre de `r.messages` est celui de la mailbox (oldest first). Si on
  veut newest-first dans la tab, faire `[...r.messages].reverse()`. Le
  proto v2 met les nouveaux en bas (textareas append-style), donc on garde
  l'ordre tel quel.
- La classification `me / them / system / other-team` est **purement
  visuelle** ; le proto rend `me` à droite et `them|system|other-team` à
  gauche. Si on veut une couleur dédiée à `system` ou `other-team`, ajouter
  les classes CSS `.bubble.system` / `.bubble.other-team` au theme (Step 1
  les a peut-être déjà — sinon ajout one-liner).

---

## 5. Actions logic — pour chaque bouton

Le squelette Step 2 expose `onAction(agentId, action: 'stop'|'start'|
'pause'|'resume'|'kill'|'restart')` et la modale de confirmation est
**interne au RightPanel** (state `confirm` qui ouvre `ConfirmModal` pour
KILL/STOP). C'est `DesktopShell` qui implémente `onAction` et appelle les
endpoints.

### 5.1 Dispatch table (au niveau `DesktopShell.onAction`)

```ts
async function onAction(agentId: string, action: AgentAction) {
  if (!selectedOrch || !selectedSession) return;
  const lead = selectedSession.id === selectedOrch.leadSessionId;

  try {
    switch (action) {
      case 'stop':
        // Lead → destroy whole orch (graceful). Worker → stop session only.
        if (lead) {
          await api.destroyOrchestrator(selectedOrch.id);
          setSelectedSessionId(null);     // close the RightPanel
        } else {
          await api.stopSession(agentId);
        }
        return;

      case 'pause':
        // Both lead and worker support pause (S5). No special lead-only path.
        await api.pauseSession(agentId);
        return;

      case 'resume':
        // Symmetric to pause. Not wired to a dedicated button in the proto
        // (REACTIVATE = start, see below) but kept in the dispatch in case
        // a future toggle uses it.
        await api.resumeSession(agentId);
        return;

      case 'restart':
        // Restart spawns a NEW session — id changes. Propagate selection to
        // the new id so the RightPanel keeps following the same logical
        // worker. Lead is NOT restartable (S5 → 409 LEAD_NOT_RESTARTABLE).
        if (lead) {
          console.warn('lead restart not supported by server (S5)');
          return;
        }
        const { newSession } = await api.restartSession(agentId);
        setSelectedSessionId(newSession.id);
        return;

      case 'kill':
        // Lead KILL = destroyOrchestrator (same endpoint, hard close).
        // Worker KILL = stopSession (gap §4-6 — no dedicated /kill route ;
        // current stopSession does a graceful kill then SIGTERM, which is
        // close enough to "kill" for v1).
        if (lead) {
          await api.destroyOrchestrator(selectedOrch.id);
          setSelectedSessionId(null);
        } else {
          await api.stopSession(agentId);
        }
        return;

      case 'start':
        // REACTIVATE button — disabled v1 (gap §4-8). The proto wires it
        // when status is stopped/failed. No backend endpoint to recreate
        // a terminated session in place ; would require recreating the
        // orch or asking the lead to spawn a worker. Tooltip "v2".
        console.warn('start/reactivate not supported v1 (gap §4-8)');
        return;
    }
  } catch (err) {
    // TODO Step 8 / D : surface error via Toasts.
    console.error(`action ${action} failed:`, err);
  }
}
```

### 5.2 Récapitulatif par bouton

| Bouton (ICON) | Lead-only? | Confirm? | Endpoint | Gap |
|---|---|---|---|---|
| STOP | non | oui (ConfirmModal) | lead: `destroyOrchestrator` / worker: `stopSession` | — |
| PAUSE | non | non | `pauseSession` (S5) | — |
| RESTART | non (lead 409) | non | `restartSession` (S5) — propager `newSession.id` | lead non restartable — bouton disabled si lead |
| KILL | non | oui (ConfirmModal) | lead: `destroyOrchestrator` / worker: `stopSession` | §4-6 (pas de `/kill` dédié) |
| REACTIVATE | non | non | aucun | §4-8 — disabled v1, tooltip "available in v2" |
| `+ WORKER` | OUI | non | aucun (ouvre `SpawnWorkerDialog` Phase C13) | §4-3 — modal en preview disabled |

### 5.3 Subtilités du squelette Step 2 à conserver

Le `RightPanel.tsx` Step 2 fait déjà :
- **REACTIVATE** : affiché si `stopped || isFailed` (sinon STOP). Bouton
  appelle `onAction(agentId, 'start')`. Pour Step 7 on garde le bouton
  visible (la condition est portée du proto) mais l'action ne fait rien
  côté backend — afficher un toast "v2" si l'utilisateur clique. Optionnel
  v1 : ajouter `title="available in v2"` + `disabled` (cf. §4-8 gap).
- **`+ WORKER`** : `disabled={!isLead || stopped || isFailed}` — déjà bon.
  Le bouton ouvre `SpawnWorkerDialog` (Phase C13). Pour Step 7 on garde le
  bouton actif quand lead, mais `setSpawnFor(team)` n'ouvre encore aucune
  modale réelle — c'est la Phase C qui livre le composant.
- **PAUSE** : `disabled={stopped || isFailed}` — pas de check `paused`,
  donc on peut cliquer PAUSE sur une session déjà paused → 409
  `ALREADY_PAUSED`. Acceptable v1 (le serveur renvoie une erreur claire,
  on la log). Une amélioration v1.1 : remplacer PAUSE par RESUME si
  `status === 'paused'` (icône `start`).
- **RESTART du lead** : le `disabled={stopped || isFailed}` du proto ne
  bloque PAS la restart d'un lead. En pratique, l'endpoint renvoie 409
  `LEAD_NOT_RESTARTABLE` (cf. `client.ts:233`). On peut soit :
  - laisser le bouton actif et laisser l'erreur HTTP se propager (UX :
    toast d'erreur côté Step 8) ;
  - **recommandé** : ajouter `disabled={... || isLead}` côté Step 7 pour
    griser le bouton sur le lead, avec `title="lead is restarted via STOP
    + recreate"`.

### 5.4 Lift vs internal — qui gère `setSpawnFor` et `setEditConfigFor` ?

`RightPanel.tsx` (Step 2) reçoit `onSpawnWorker(team)` et
`onEditConfig(team)` en props. Step 2 les a câblés vers
`setSpawnFor(team)` / `setEditConfigFor(team)` du `DesktopShell`. **On
garde tel quel pour Step 7**. Les modales (`SpawnWorkerDialog`,
`EditConfigDialog`) sont l'objet du Step 13 (Phase C). Step 7 conserve les
setters non-utilisés (sous-entendu : `const [spawnFor, setSpawnFor]` au
lieu de `const [, setSpawnFor]` — au moins le getter sera lu plus tard).

---

## 6. Tabs implementation

### 6.1 Tab CONSOLE

**Palette warm-black** — modifier `Terminal.tsx` :

```ts
term = new XTerm({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, ...',
  fontSize: 13,
  theme: {
    background: '#0d0a08',           // <- était '#0b1220'
    foreground: '#f3e9dc',           // texte ambré-blanc (var(--text))
    cursor: '#ffb060',                // ambre soft (var(--amber))
    cursorAccent: '#0d0a08',
    selectionBackground: 'rgba(255,176,96,0.25)',
  },
  cursorBlink: true,
  scrollback: 5000,
  convertEol: true,
});
```

> Les codes ANSI de Claude (couleurs vives) traversent xterm tel quel
> (cf. preamble de `Terminal.tsx`, S11 option a). Le seul changement est la
> couleur de **fond** (`background`) + couleurs du chrome xterm
> (`foreground`/`cursor`/`selection`). Aucune retouche du parser ANSI.

**Pastille WRITER/READER** — déjà câblée dans le squelette Step 2
(lignes du JSX `pr-tabs-meta` + `chip ${writer ? 'writer' : 'reader'}`).
Reste à alimenter `selected.writer` depuis le hello frame :

- `Terminal.tsx` reçoit `'attached' { role: 'writer' }` ou
  `'role-changed' { role: 'reader' }` du serveur (cf. `Terminal.tsx:82-86`).
- On ajoute `props.onRoleChange?.('writer' | 'reader')` (cf. §4.2).
- `DesktopShell` accumule dans `writer: boolean | undefined` et le passe à
  `RightPanel` via `selected.writer`.

**Stopped / failed** : si la session est terminée, la pastille n'est pas
rendue (condition `!stopped && !isFailed` déjà dans Step 2). Le terminal
montre un placeholder texte (déjà géré).

**Montage Terminal.tsx** — au lieu du placeholder "console mounting point
(Step 7)" du squelette Step 2, on monte le composant directement dans la
zone `.console` :

```tsx
{activeTab === 'console' && (
  <div className="console" ref={consoleRef}>
    {stopped || isFailed ? (
      <div style={{ color: 'var(--text-mute)', padding: '8px 0' }}>
        {isFailed
          ? '— agent failed — see EXIT REASON in CONFIG tab —'
          : '— agent stopped, no log output —'}
      </div>
    ) : (
      <Terminal
        sessionId={selected.id}
        onRoleChange={onTerminalRoleChange}
        onDataFrame={onTerminalDataFrame}
      />
    )}
  </div>
)}
```

> ⚠ Attention : `Terminal.tsx` a son propre conteneur flex et son chrome
> ("WS: open · role: writer"). Ce chrome jure avec le design v2 — on peut :
> 1. Garder le chrome (debug visible) — pragmatique pour Step 7.
> 2. Faire `Terminal.tsx` accepter un prop `hideChrome?: boolean` pour le
>    masquer dans le RightPanel (l'info WRITER/READER est déjà dans la
>    pastille v2). **Recommandé** pour la propreté visuelle.
> 3. Refondre `Terminal.tsx` pour qu'il rende uniquement le `div` xterm.
>    Plus invasif, reporté à Step 7+ ou Phase D polish.

Recommandation Step 7 : option 2 (ajouter `hideChrome` qui squeeze les 3
lignes de status + le wrapper `flex flex-col`). Diff minimal.

### 6.2 Tab MESSAGES

**Polling + classification** : cf. §4.4. Le rendu est déjà dans le
squelette Step 2 (lignes 1772-1791). On corrige juste le label du `who`
pour utiliser `m.who` (Step 2 mettait déjà `who: cls.authorLabel`, donc
rien à toucher) et on rend `m.via` quand c'est cross-team.

**Bulle kind → style** : le squelette Step 2 fait
`bubble ${m.from === 'me' ? 'me' : 'them'}` — c'est-à-dire que les 4 kinds
collapsent en 2 colonnes (me à droite, others à gauche). Pour Step 7 on
peut soit :
- garder ce collapse (acceptable v1) ;
- distinguer les 4 kinds : `bubble ${m.from}` → classes CSS `.bubble.me`,
  `.bubble.them`, `.bubble.system`, `.bubble.other-team` (Step 1 doit
  fournir ces 4 classes — vérifier `desktop-theme.css`).

**Recommandé Step 7** : garder le collapse `me / them` pour le styling,
mais utiliser `who` pour exposer la nuance (YOU / SYSTEM / Atlas / lead-1 /
abc1). C'est ce que fait la classification S12 par construction. La
distinction `other-team` est surfacée par `· via {team.name}` à droite du
who (déjà dans Step 2 ligne 1785).

**État vide** : déjà géré par le squelette (`— no messages yet —` ou
`— agent stopped —`).

### 6.3 Tab CONFIG

Le squelette `ConfigTab.tsx` (Step 2) attend `ConfigTabTeam` et
`ConfigTabAgent`. On les construit dans `DesktopShell` (ou directement à
partir de `rightPanelTeam` qui étend `ConfigTabTeam` — Step 2 a fait cet
extends exprès, cf. `RightPanelTeam extends ConfigTabTeam`).

**Sections rendues par `ConfigTab` (déjà livré Step 2)** :

| Section | Source (côté RightPanelTeam / Agent) |
|---|---|
| RUNTIME CONFIG | `team.model`, `team.effort`, `team.permissionMode`, `team.cwd`, `agent.pid`, `agent.startedAt` + EXIT REASON si `status ∈ {exited, killed, failed}` |
| LEAD PROMPT | `team.leadPrompt` (depuis `role.leadPrompt`) — fallback `'— (none) —'` |
| LEAD PREAMBLE | `team.leadPreamble` (depuis `OrchestratorView.leadPreamble`) — fallback `'— (none) —'` |
| WORKER PREAMBLE | `team.workerPreamble` (depuis `OrchestratorView.workerPreamble`) — fallback `'— (none) —'` |
| CONNECTORS | `team.discordWebhook` (depuis `role.connectors[].webhookUrl`) — fallback message d'aide |

**Étendre `ConfigTabAgent` avec `exitCode` (S2 a déjà ajouté
`exitCode?: number | null`) et `stopReason`** :

Le squelette Step 2 §3.12 ne mentionne pas `stopReason` ni `lastError`
dans `ConfigTabAgent`. Pour la ligne EXIT REASON, on a besoin de :
- `agent.status` (déjà là) — pour le verdict EXITED/KILLED/FAILED.
- `agent.exitCode` (déjà optionnel) — pour `code=N`.
- `agent.stopReason` (à ajouter, optionnel) — pour distinguer
  `interrupted`/`server-restart`.
- `agent.lastError` (à ajouter, optionnel) — pour la cause si `failed`.

**Diff `ConfigTab.tsx`** (à appliquer en Step 7) :

```ts
// ConfigTabAgent étendu
export interface ConfigTabAgent {
  pid: number | null;
  startedAt: string | number | null;
  status: string;
  exitCode?: number | null;
  stopReason?: string | null;     // NOUVEAU
  lastError?: string | null;      // NOUVEAU
}

// Ligne EXIT REASON enrichie
{stopped && (
  <>
    <span className="k">EXIT REASON</span>
    <span className="v" style={{
      color: agent.status === 'failed' ? 'var(--bad)' : 'var(--text-dim)',
    }}>
      {agent.status.toUpperCase()}
      {agent.exitCode != null && ` :: code=${agent.exitCode}`}
      {agent.stopReason && ` · ${agent.stopReason}`}
    </span>
    {agent.lastError && (
      <>
        <span className="k">ERROR</span>
        <span className="v" style={{ color: 'var(--bad)', whiteSpace: 'pre-wrap' }}>
          {agent.lastError}
        </span>
      </>
    )}
  </>
)}
```

> Le squelette Step 2 utilise `(agent.status === 'exited' || ... ||
> 'failed')` pour `stopped`. Ici on s'aligne sur la définition du
> RightPanel qui inclut aussi `'interrupted'` et `'killed'`. À harmoniser
> dans `ConfigTab.tsx` (changer la définition locale `stopped` pour
> couvrir les 4 cas comme dans le RightPanel).

**Discord chip** : le squelette Step 2 le rend correctement quand
`team.discordWebhook != null`. Aucune retouche Step 7.

---

## 7. Composer logic — toggles, dispatch, validation

Le squelette Step 2 expose `Composer` avec props complets (cf. §3.13).
Step 7 implémente le `onSend` du `RightPanel` qui appelle le bon endpoint
selon `{mode, audience}`.

### 7.1 Dispatch table (au niveau `DesktopShell.onSend`)

```ts
async function onSend(
  agentId: string,
  text: string,
  opts: { mode: ComposerMode; audience: ComposerAudience },
) {
  if (!selectedOrch) return;
  const trimmed = text.trim();
  if (!trimmed) return;

  // Audience TEAM is lead-only (UI doesn't render the toggle for workers).
  // Audience AGENT in PTY mode = postSessionInput. In MAILBOX mode =
  // disabled v1 (no /sessions/:id/mail endpoint, gap §4-5).
  // Audience TEAM in PTY mode = broadcastToOrchestrator (the server
  // broadcasts as a mailbox push for now ; the proto label "PTY broadcast"
  // is a UI fiction — the actual semantics on the wire are mailbox).
  // Audience TEAM in MAILBOX mode = broadcastToOrchestrator (same path).

  try {
    if (opts.audience === 'team') {
      // Both PTY and MAILBOX collapse to broadcastToOrchestrator.
      // Server route is "human → all sessions mailbox push".
      await api.broadcastToOrchestrator(selectedOrch.id, trimmed);
      return;
    }

    // audience === 'agent'
    if (opts.mode === 'mailbox') {
      console.warn('AGENT/MAILBOX disabled v1 (gap §4-5)');
      return;
    }
    // AGENT + PTY : raw keystrokes. Append \n so the line is submitted.
    const data = trimmed.endsWith('\n') ? trimmed : trimmed + '\n';
    await api.postSessionInput(agentId, data);
  } catch (err) {
    console.error('send failed:', err);
  }
}
```

### 7.2 État des toggles (déjà géré par RightPanel Step 2)

| State | Default | Effect |
|---|---|---|
| `composerMode: 'pty'\|'mailbox'` | `'pty'` | reset à `'pty'` quand `selected.id` change |
| `audience: 'agent'\|'team'` | `'agent'` | reset à `'agent'` quand `selected.id` change ; toggle TEAM visible uniquement si `isLead` |
| `draft: string` | `''` | reset à `''` quand `selected.id` change |

### 7.3 Disabled / validation

- `disabled={stopped || !draft.trim()}` (déjà dans Step 2) — couvre les
  cas `exited/killed/interrupted/failed/stopped`.
- Si `audience === 'agent' && composerMode === 'mailbox'` : v1 le toggle
  est cliquable visuellement mais le `onSend` no-op et log un warn. **À
  améliorer Step 7** : griser le bouton INBOX (audience agent) avec
  tooltip "v2", soit en désactivant le bouton du `seg` quand
  `audience === 'agent'`, soit en bloquant côté send button (badge "v2"
  affiché en place de SEND).

**Recommandé** : désactiver visuellement le toggle INBOX **uniquement
quand `audience === 'agent'`** :

```tsx
<button
  className={composerMode === 'mailbox' ? 'on' : ''}
  onClick={() => audience === 'team' && setComposerMode('mailbox')}
  disabled={audience === 'agent'}
  title={audience === 'agent'
    ? 'AGENT mailbox is v2 (gap §4-5)'
    : 'enqueue in mailbox (you-have-mail signal)'}
>→ INBOX</button>
```

Le toggle INBOX reste actif en mode TEAM (puisque
`broadcastToOrchestrator` est techniquement une mailbox push, donc
sémantiquement correct).

### 7.4 Endpoints — récapitulatif

| {audience, mode} | Endpoint | Comportement |
|---|---|---|
| AGENT / PTY | `api.postSessionInput(id, text + '\n')` | bytes bruts vers le PTY ; débloque un agent en `waiting` |
| AGENT / INBOX | — (gap §4-5) | toggle disabled v1, no-op |
| TEAM / PTY | `api.broadcastToOrchestrator(orchId, text)` | mailbox push à toutes les sessions actives (lead-only) |
| TEAM / INBOX | `api.broadcastToOrchestrator(orchId, text)` | idem (le wire path est le même côté serveur) |

### 7.5 Composer-helper et send-target

Déjà rendus par `Composer.tsx` (Step 2) — pas de changement Step 7. Les
textes contextuels (`helper` + `teamHelper` + `placeholder`) sont déjà
gérés par switch sur `(composerMode, audience, stopped)`.

---

## 8. Components — `RightPanel.tsx` complet (Step 7)

> Le squelette Step 2 (`02_desktop-skeleton.md` §3.15) livre déjà ~250
> lignes de JSX. Les modifications Step 7 sont **chirurgicales** : on
> change les sources de données (déjà passées en props) et on ajoute le
> montage de `Terminal.tsx` dans la tab CONSOLE. **Aucune réécriture du
> JSX.** Le code ci-dessous reproduit le composant entier dans son état
> Step 7 final pour référence directe.

```tsx
// packages/web/src/components/desktop/RightPanel.tsx
// Step 7 — alimenté par DesktopShell (selected, team, messages, callbacks).
// Le composant lui-même n'a pas de hooks de données : il rend les props.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ICON } from './icons';
import ConfigTab, { type ConfigTabTeam } from './ConfigTab';
import Composer, { type ComposerAudience, type ComposerMode } from './Composer';
import ConfirmModal from './ConfirmModal';
import { Terminal } from '../Terminal';
import {
  formatUptime, formatClockShort, formatRelative,
  statusChipClass, statusLabel,
} from '../../lib/format';
import { formatLoadPercent } from '../../lib/loadPercent';

export type AgentAction = 'stop' | 'start' | 'pause' | 'resume' | 'kill' | 'restart';

export interface RightPanelAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  pid: number | null;
  startedAt: string | number | null;
  lastActivityAt: string | number | null;
  load?: number;
  logLines?: number;
  writer?: boolean;
  // Étendus en Step 7 pour la section EXIT REASON du ConfigTab.
  exitCode?: number | null;
  stopReason?: string | null;
  lastError?: string | null;
}

export interface RightPanelTeam extends ConfigTabTeam {
  id: string;
  name: string;
  leadId: string;
  workerCount: number;
  discordWebhook?: string | null;
}

export interface MessageBubble {
  from: 'me' | 'them' | 'system' | 'other-team';
  who: string;
  text: string;
  ts?: string | number;
  via?: string;
}

export type RightPanelTab = 'console' | 'chat' | 'config';

interface Props {
  selected: RightPanelAgent | null;
  team: RightPanelTeam | null;
  isLead: boolean;
  messages: readonly MessageBubble[];
  activeTab: RightPanelTab;
  setActiveTab: (t: RightPanelTab) => void;
  onClose: () => void;
  onAction: (agentId: string, action: AgentAction) => void;
  onSend: (
    agentId: string,
    text: string,
    opts: { mode: ComposerMode; audience: ComposerAudience },
  ) => void;
  onSpawnWorker: (team: RightPanelTeam) => void;
  onEditConfig: (team: RightPanelTeam) => void;
  // Step 7 : callbacks Terminal.tsx → DesktopShell pour writer + logLines.
  onTerminalRoleChange?: (role: 'writer' | 'reader') => void;
  onTerminalDataFrame?: () => void;
}

export default function RightPanel({
  selected, team, isLead, messages,
  activeTab, setActiveTab,
  onClose, onAction, onSend, onSpawnWorker, onEditConfig,
  onTerminalRoleChange, onTerminalDataFrame,
}: Props) {
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  const [composerMode, setComposerMode] = useState<ComposerMode>('pty');
  const [audience, setAudience] = useState<ComposerAudience>('agent');
  const [confirm, setConfirm] = useState<
    { action: AgentAction; label: string; body: string; cls: 'danger' } | null
  >(null);

  // Reset local composer state when changing session.
  useEffect(() => {
    setDraft('');
    setComposerMode('pty');
    setAudience('agent');
  }, [selected?.id]);

  // Auto-scroll console on session/tab change (xterm gère son propre
  // scroll en flux normal, mais on garde ce reset au cas où).
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [selected?.id, activeTab]);

  if (!selected || !team) {
    return (
      <aside className="panel-right closed">
        <div className="pr-empty"><div className="pr-empty-inner">no agent selected</div></div>
      </aside>
    );
  }

  const status = selected.status;
  const stopped =
    status === 'exited' || status === 'killed' || status === 'interrupted' || status === 'stopped';
  const isFailed = status === 'failed';
  const writer = selected.writer !== false;     // undefined → assume writer
  const hasDiscord = !!team.discordWebhook;

  function doSend() {
    const txt = draft.trim();
    if (!txt || !selected) return;
    onSend(selected.id, txt, { mode: composerMode, audience });
    setDraft('');
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doSend();
    }
  }

  function askConfirm(action: AgentAction) {
    if (!selected || !team) return;
    if (action === 'kill') {
      setConfirm({
        action,
        label: 'KILL SESSION',
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
        label: 'STOP SESSION',
        body: isLead
          ? `STOP ${selected.name} will gracefully shut down the entire ${team.name} team and its ${team.workerCount} workers.`
          : `STOP ${selected.name} will gracefully shut down this worker.`,
        cls: 'danger',
      });
      return;
    }
    onAction(selected.id, action);
  }

  return (
    <aside className="panel-right">
      <div className="pr-head">
        <div className="pr-top">
          <div>
            <div className="pr-id">
              {team.name} :: {isLead ? 'LEAD' : 'WORKER'} :: {selected.id.toUpperCase()}
            </div>
          </div>
          <button className="pr-close" onClick={onClose} title="close">×</button>
        </div>
        <div className="pr-name">
          {selected.name}
          {isLead && <span className="badge">LEAD</span>}
          <span style={{ flex: 1 }} />
          <span className={`chip ${statusChipClass(status)}`}>
            <span className={`dot ${statusChipClass(status)}`} />
            {statusLabel(status)}
          </span>
        </div>
        <div className="pr-role">
          <span>{selected.role}</span>
          {hasDiscord && (
            <span className="discord-chip" title={team.discordWebhook ?? ''}>◇ DISCORD</span>
          )}
        </div>

        <div className="pr-cfgline">
          <span className="lbl">M</span>
          <span>{team.model.replace('claude-', '')}</span>
          <span className="sep">·</span>
          <span className="lbl">E</span>
          <span>{team.effort}</span>
          <span className="sep">·</span>
          <span className="lbl">P</span>
          <span style={{
            color: team.permissionMode === 'bypassPermissions' ? 'var(--warn)' : 'inherit',
          }}>{team.permissionMode}</span>
          <button className="edit"
            title="rotate model / effort / permission (v2)"
            onClick={() => onEditConfig(team)}>
            {ICON.pencil}
          </button>
        </div>

        <div className="pr-cwd" title="workspace-relative path">
          <span className="lbl">CWD ::</span> {team.cwd}
        </div>

        <div className="pr-stats">
          <div className="pr-stat">
            <div className="v">
              {stopped ? '—' : formatLoadPercent(selected.load)}
            </div>
            <div className="k">LOAD</div>
          </div>
          <div className="pr-stat">
            <div className="v">{stopped ? '—' : formatUptime(selected.startedAt)}</div>
            <div className="k">UPTIME</div>
          </div>
          <div className="pr-stat">
            <div className="v">{(selected.logLines ?? 0).toLocaleString()}</div>
            <div className="k">LOG LINES</div>
          </div>
        </div>

        <div className="pr-meta">
          <span><b>pid</b>={selected.pid ?? '—'}</span>
          <span className="sep">·</span>
          <span>
            <b>started</b>={selected.startedAt ? formatClockShort(selected.startedAt) : '—'}
          </span>
          <span className="sep">·</span>
          <span>
            <b>last_activity</b>=
            {selected.lastActivityAt ? formatRelative(selected.lastActivityAt) : '—'}
          </span>
        </div>
      </div>

      <div className="pr-actions">
        {(stopped || isFailed) ? (
          <button className="pr-action go"
            disabled                                  /* gap §4-8 */
            title="reactivate available in v2"
            onClick={() => onAction(selected.id, 'start')}>
            {ICON.start}<span>REACTIVATE</span>
          </button>
        ) : (
          <button className="pr-action danger" onClick={() => askConfirm('stop')}>
            {ICON.stop}<span>STOP</span>
          </button>
        )}
        <button className="pr-action"
          disabled={stopped || isFailed}
          onClick={() => onAction(selected.id, 'pause')}>
          {ICON.pause}<span>PAUSE</span>
        </button>
        <button className="pr-action primary"
          disabled={stopped || isFailed || isLead /* lead non restartable, S5 409 */}
          title={isLead ? 'lead is restarted via STOP + recreate' : 'restart this worker'}
          onClick={() => onAction(selected.id, 'restart')}>
          {ICON.reload}<span>RESTART</span>
        </button>
        <button className="pr-action danger" onClick={() => askConfirm('kill')}>
          {ICON.kill}<span>KILL</span>
        </button>
        <button className="pr-action primary"
          disabled={!isLead || stopped || isFailed}
          onClick={() => onSpawnWorker(team)}
          title={isLead ? 'spawn worker (v2 preview)' : 'lead-only action'}>
          {ICON.fork}<span>+ WORKER</span>
        </button>
      </div>

      <div className="pr-tabs">
        <button className={`pr-tab ${activeTab === 'console' ? 'active' : ''}`}
          onClick={() => setActiveTab('console')}>CONSOLE</button>
        <button className={`pr-tab ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}>MESSAGES</button>
        <button className={`pr-tab ${activeTab === 'config' ? 'active' : ''}`}
          onClick={() => setActiveTab('config')}>CONFIG</button>
        <div className="pr-tabs-meta">
          {activeTab === 'console' && !stopped && !isFailed && (
            <span className={`chip ${writer ? 'writer' : 'reader'}`}
              title={writer
                ? 'PTY writer — keystrokes will reach the agent'
                : 'PTY reader — passive view, no writes'}>
              <span className={`dot ${writer ? 'ok' : 'stopped'}`} />
              {writer ? 'WRITER' : 'READER'}
            </span>
          )}
        </div>
      </div>

      <div className="pr-body">
        {activeTab === 'console' && (
          <div className="console" ref={consoleRef}>
            {stopped || isFailed ? (
              <div style={{ color: 'var(--text-mute)', padding: '8px 0' }}>
                {isFailed
                  ? '— agent failed — see EXIT REASON in CONFIG tab —'
                  : '— agent stopped, no log output —'}
              </div>
            ) : (
              <Terminal
                sessionId={selected.id}
                onRoleChange={onTerminalRoleChange}
                onDataFrame={onTerminalDataFrame}
                hideChrome                              /* nouvelle prop Step 7 */
              />
            )}
          </div>
        )}

        {activeTab === 'chat' && (
          <div className="messages">
            {messages.length === 0 && (
              <div style={{
                color: 'var(--text-mute)', textAlign: 'center', marginTop: 30,
                fontFamily: 'Geist Mono, monospace', fontSize: 11, letterSpacing: '0.10em',
              }}>
                {stopped ? '— agent stopped —' : '— no messages yet —'}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`bubble ${m.from === 'me' ? 'me' : 'them'}`}>
                <div className="who">
                  {m.who}
                  {m.via && (
                    <span style={{ marginLeft: 8, color: 'var(--text-mute)' }}>
                      · via {m.via}
                    </span>
                  )}
                </div>
                <div>{m.text}</div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'config' && (
          <ConfigTab
            team={team}
            agent={selected}
            isLead={isLead}
            onEdit={() => onEditConfig(team)}
          />
        )}

        {activeTab !== 'config' && (
          <Composer
            selectedName={selected.name}
            teamName={team.name}
            isLead={isLead}
            stopped={stopped || isFailed}
            draft={draft}
            setDraft={setDraft}
            onKey={onKey}
            onSend={doSend}
            composerMode={composerMode}
            setComposerMode={setComposerMode}
            audience={audience}
            setAudience={setAudience}
          />
        )}
      </div>

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
    </aside>
  );
}
```

---

## 9. `ConfigTab.tsx` — diff Step 7 (RUNTIME / LEAD PROMPT / LEAD PREAMBLE / WORKER PREAMBLE / CONNECTORS)

Le squelette Step 2 (§3.12) livre déjà la structure complète. Step 7
applique **3 modifications** :

1. **Étendre `ConfigTabAgent`** avec `stopReason?` et `lastError?` (cf.
   §6.3 ci-dessus).
2. **Harmoniser la condition `stopped`** avec celle du RightPanel
   (inclure `'interrupted'` + `'killed'` + `'stopped'`).
3. **Enrichir la ligne EXIT REASON** avec `stopReason` et la ligne ERROR
   pour `lastError` (cf. §6.3).

```tsx
// packages/web/src/components/desktop/ConfigTab.tsx — Step 7
import { formatClockShort } from '../../lib/format';

export interface ConfigTabTeam {
  model: string;
  effort: string;
  permissionMode: string;
  cwd: string;
  leadPrompt: string | null;
  leadPreamble: string | null;
  workerPreamble: string | null;
  discordWebhook?: string | null;
}

export interface ConfigTabAgent {
  pid: number | null;
  startedAt: string | number | null;
  status: string;
  exitCode?: number | null;
  stopReason?: string | null;   // Step 7
  lastError?: string | null;    // Step 7
}

interface Props {
  team: ConfigTabTeam;
  agent: ConfigTabAgent;
  isLead: boolean;
  onEdit: () => void;
}

export default function ConfigTab({ team, agent, isLead: _isLead, onEdit }: Props) {
  const stopped =
    agent.status === 'exited' ||
    agent.status === 'killed' ||
    agent.status === 'interrupted' ||
    agent.status === 'stopped' ||
    agent.status === 'failed';

  return (
    <div className="cfg">
      <div className="cfg-section">
        <div className="cfg-h">
          <span>RUNTIME CONFIG</span>
          <button className="h-edit" onClick={onEdit}>EDIT</button>
        </div>
        <div className="cfg-kv">
          <span className="k">MODEL</span><span className="v">{team.model}</span>
          <span className="k">EFFORT</span><span className="v">{team.effort}</span>
          <span className="k">PERMISSION</span>
          <span className="v" style={{
            color: team.permissionMode === 'bypassPermissions' ? 'var(--warn)' : 'var(--text)',
          }}>
            {team.permissionMode}
            {team.permissionMode === 'bypassPermissions' && (
              <span style={{ marginLeft: 8, color: 'var(--text-mute)' }}>
                // danger: agent runs unattended
              </span>
            )}
          </span>
          <span className="k">CWD</span><span className="v">{team.cwd}</span>
          <span className="k">PID</span><span className="v">{agent.pid ?? '—'}</span>
          <span className="k">STARTED</span>
          <span className="v">
            {agent.startedAt ? formatClockShort(agent.startedAt) : '—'}
          </span>
          {stopped && (
            <>
              <span className="k">EXIT REASON</span>
              <span className="v" style={{
                color: agent.status === 'failed' ? 'var(--bad)' : 'var(--text-dim)',
              }}>
                {agent.status.toUpperCase()}
                {agent.exitCode != null && ` :: code=${agent.exitCode}`}
                {agent.stopReason && ` · ${agent.stopReason}`}
              </span>
              {agent.lastError && (
                <>
                  <span className="k">ERROR</span>
                  <span className="v" style={{
                    color: 'var(--bad)', whiteSpace: 'pre-wrap',
                  }}>
                    {agent.lastError}
                  </span>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>LEAD PROMPT</span></div>
        <div className="cfg-pre">{team.leadPrompt ?? '— (none) —'}</div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>LEAD PREAMBLE</span></div>
        <div className="cfg-pre">{team.leadPreamble ?? '— (none) —'}</div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>WORKER PREAMBLE</span></div>
        <div className="cfg-pre">{team.workerPreamble ?? '— (none) —'}</div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>CONNECTORS</span></div>
        {team.discordWebhook ? (
          <div className="cfg-kv">
            <span className="k">DISCORD</span>
            <span className="v" style={{
              display: 'inline-flex', gap: 8, alignItems: 'center',
            }}>
              <span className="discord-chip" style={{
                fontSize: 8.5, padding: '1px 6px',
                border: '1px solid rgba(255,176,96,0.4)',
                color: 'var(--amber)', letterSpacing: '0.14em',
              }}>ENABLED</span>
              <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>
                {team.discordWebhook.length > 40
                  ? `${team.discordWebhook.slice(0, 38)}…`
                  : team.discordWebhook}
              </span>
            </span>
          </div>
        ) : (
          <div className="field-help">
            No connectors configured for this role. Edit the role to add a Discord webhook.
          </div>
        )}
      </div>
    </div>
  );
}
```

> **`isLead` prop** : actuellement non utilisé par `ConfigTab` (préfixé
> `_isLead`). Conserver le param pour la signature stable — un futur Step
> pourrait masquer la section WORKER PREAMBLE quand `!isLead && workerCount === 0`.

---

## 10. `Composer.tsx` — diff Step 7 (toggle INBOX disabled si AGENT)

Le squelette Step 2 (§3.13) est presque complet. Modification Step 7 :
**désactiver le bouton INBOX quand `audience === 'agent'`** (gap §4-5).

```tsx
// packages/web/src/components/desktop/Composer.tsx — Step 7
import type { KeyboardEvent } from 'react';

export type ComposerMode = 'pty' | 'mailbox';
export type ComposerAudience = 'agent' | 'team';

interface Props {
  selectedName: string;
  teamName: string;
  isLead: boolean;
  stopped: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  composerMode: ComposerMode;
  setComposerMode: (m: ComposerMode) => void;
  audience: ComposerAudience;
  setAudience: (a: ComposerAudience) => void;
}

export default function Composer({
  selectedName, teamName, isLead, stopped,
  draft, setDraft, onKey, onSend,
  composerMode, setComposerMode,
  audience, setAudience,
}: Props) {
  // gap §4-5 : AGENT+INBOX is disabled v1. Force-flip the mode back to
  // PTY when audience changes to agent and mode is mailbox.
  // (Optional defensive behaviour ; the disabled button already prevents
  // the user from reaching that combo, but a programmatic reset keeps
  // state consistent in case the disabled rule changes later.)
  const inboxDisabled = audience === 'agent';
  const effectiveMode = inboxDisabled && composerMode === 'mailbox' ? 'pty' : composerMode;

  const helper = effectiveMode === 'mailbox'
    ? "MAILBOX :: queued in agent inbox · agent gets 'you have mail' signal on next idle"
    : 'PTY :: bytes written direct to terminal · unblocks an agent waiting on input';
  const teamHelper = audience === 'team'
    ? "Audience: every active session of this team will receive your message as from='human'."
    : 'Audience: this single session only.';

  return (
    <div className="composer">
      <div className="composer-toolbar">
        <div className="composer-toggles">
          <div className="seg" role="group" aria-label="composer mode">
            <button
              className={effectiveMode === 'pty' ? 'on' : ''}
              onClick={() => setComposerMode('pty')}
              title="write to PTY (raw keystrokes)"
            >→ PTY</button>
            <button
              className={effectiveMode === 'mailbox' ? 'on' : ''}
              onClick={() => !inboxDisabled && setComposerMode('mailbox')}
              disabled={inboxDisabled}
              title={inboxDisabled
                ? 'AGENT mailbox not available v1 (gap §4-5) — use TEAM audience to broadcast via mailbox'
                : 'enqueue in mailbox (you-have-mail signal)'}
            >→ INBOX</button>
          </div>
          {isLead && (
            <div className="seg" role="group" aria-label="audience">
              <button
                className={audience === 'agent' ? 'on' : ''}
                onClick={() => setAudience('agent')}
                title="single session"
              >AGENT</button>
              <button
                className={audience === 'team' ? 'on' : ''}
                onClick={() => setAudience('team')}
                title="broadcast to team"
              >TEAM</button>
            </div>
          )}
        </div>
        <span style={{ color: 'var(--text-mute)' }}>⌘+↵ to send</span>
      </div>

      <div className="composer-row">
        <span className={`send-target ${audience === 'team' ? 'broadcast' : ''}`}>
          {audience === 'team' ? 'BROADCAST' : 'CHANNEL'} <span className="arrow">→</span>{' '}
          {audience === 'team' ? `ALL OF ${teamName}` : selectedName}
          <span style={{ color: 'var(--text-mute)', marginLeft: 8 }}>
            :: {effectiveMode === 'pty' ? 'PTY' : 'MAILBOX'}
          </span>
        </span>
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        className={effectiveMode === 'mailbox' ? 'mailbox' : ''}
        placeholder={
          stopped
            ? 'agent stopped — reactivate to send'
            : audience === 'team'
              ? 'compose broadcast directive to the entire team…'
              : effectiveMode === 'mailbox'
                ? 'compose mailbox message (agent will be notified on next idle)…'
                : 'compose PTY input (sent as raw keystrokes)…'
        }
        disabled={stopped}
      />
      <div className="composer-helper">
        {helper}
        {isLead && <div style={{ marginTop: 2 }}>{teamHelper}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          className="send-btn"
          disabled={stopped || !draft.trim()}
          onClick={onSend}
        >
          {audience === 'team' ? 'BROADCAST →' : 'SEND →'}
        </button>
      </div>
    </div>
  );
}
```

---

## 11. Plan d'implémentation pas-à-pas (ordre des fichiers)

Ordre topologique pour éviter les cycles et garder `pnpm tsc --noEmit` vert
à chaque étape :

1. **`packages/web/src/components/Terminal.tsx`** —
   - Changer le theme xterm : `background: '#0d0a08'` (+ foreground/cursor
     warm-black).
   - Ajouter les props optionnelles `onRoleChange?(role)`,
     `onDataFrame?()`, `hideChrome?: boolean`.
   - Câbler `props.onRoleChange?.(o.role)` dans `case 'attached'` et
     `case 'role-changed'`.
   - Câbler `props.onDataFrame?.()` dans `case 'data'` (1 call par frame).
   - Si `hideChrome`, supprimer le `<div className="flex items-center
     gap-2 text-xs text-slate-400 mb-1">` du return.
   - **Test** : `pnpm tsc --noEmit` (les callers existants —
     `OrchestratorView.tsx` — ne passent pas les nouvelles props, donc OK
     puisqu'elles sont optionnelles).

2. **`packages/web/src/components/desktop/ConfigTab.tsx`** —
   - Étendre `ConfigTabAgent` avec `stopReason?: string | null` et
     `lastError?: string | null`.
   - Harmoniser la condition `stopped` (5 états).
   - Enrichir la ligne EXIT REASON avec `stopReason` et ajouter la ligne
     ERROR pour `lastError`.

3. **`packages/web/src/components/desktop/Composer.tsx`** —
   - Calculer `inboxDisabled = audience === 'agent'`.
   - Désactiver le bouton INBOX si `inboxDisabled` + tooltip "v2".
   - Force-flip vers PTY si `inboxDisabled && composerMode === 'mailbox'`
     via `effectiveMode`.

4. **`packages/web/src/components/desktop/RightPanel.tsx`** —
   - Étendre `RightPanelAgent` avec `exitCode?`, `stopReason?`,
     `lastError?` (à propager à `ConfigTab` via `agent={selected}`).
   - Ajouter props `onTerminalRoleChange?`, `onTerminalDataFrame?`.
   - Remplacer le placeholder console par `<Terminal sessionId={selected.id}
     onRoleChange={onTerminalRoleChange} onDataFrame={onTerminalDataFrame}
     hideChrome />`.
   - Utiliser `formatLoadPercent(selected.load)` au lieu du
     `Math.round((selected.load ?? 0) * 100) + '%'` inline.
   - Désactiver REACTIVATE (gap §4-8) + RESTART du lead (S5 409).
   - Inclure `'stopped'` dans la définition locale de `stopped`.

5. **`packages/web/src/components/desktop/DesktopShell.tsx`** —
   - Importer `useRoles`, `useSession`, `peekInbox`, `classifyBubble`,
     `MailMessageView`.
   - Ajouter les états `logLines`, `writer`, `inboxMessages`.
   - Créer les callbacks `onTerminalRoleChange`, `onTerminalDataFrame` et
     l'effet `useEffect` qui les reset à chaque changement de session.
   - Ajouter l'effet de poll `peekInbox` (3 s) sur la session sélectionnée.
   - Calculer `messageBubbles` via `useMemo` + `classifyBubble`.
   - Implémenter `buildRightPanelTeam(orch, role, leadCwd)` et
     `buildRightPanelAgent(session, logLines, writer)` (inline ou dans
     `desktop/rightPanelAdapters.ts`).
   - Calculer `selectedOrch`, `selectedRole`, `isLead` via `useMemo`.
   - Implémenter `onAction(agentId, action)` (dispatch S5 + destroy).
   - Implémenter `onSend(agentId, text, opts)` (dispatch PTY/team).
   - Passer toutes les nouvelles props au `<RightPanel />`.

6. **`packages/web/src/components/desktop/rightPanelAdapters.ts`**
   (OPTIONNEL — extraction des helpers `buildRightPanelTeam` /
   `buildRightPanelAgent` pour les rendre testables séparément).

7. **Tests unitaires** :
   - `packages/web/src/components/desktop/rightPanelAdapters.test.ts` —
     `buildRightPanelTeam` (avec et sans role, avec et sans Discord),
     `buildRightPanelAgent` (load undefined, writer undefined).
   - `packages/web/src/components/desktop/Composer.test.tsx` (si pas déjà
     fait Step 2) — vérifier que cliquer INBOX en mode AGENT ne change
     pas `composerMode` ; tooltip présent ; rendu disabled.

8. **`packages/web/src/components/OrchestratorView.tsx`** —
   Si Step 3 a déjà supprimé ce composant (cf. plan §5.2), rien à faire.
   Sinon, vérifier que Terminal.tsx fonctionne toujours (`hideChrome`
   absent → chrome visible, comportement legacy préservé).

---

## 12. Tests de fumée

Manuels, dans l'ordre où les exécuter après déploiement
(`docker build -t swarm-os:latest . && docker compose -f docker-compose.test.yml up -d`,
cf. memory `project_docker_redeploy.md`) :

### 12.1 Head + cfg + meta
- [ ] Cliquer un lead node sur la MapView → RightPanel s'ouvre,
      `pr-id` = `{team.name} :: LEAD :: {SESSION_ID_UPPER}`.
- [ ] `pr-name` affiche le nom de la session + badge `LEAD` + chip statut.
- [ ] `pr-role` affiche le role serveur + chip Discord uniquement si le
      role définit un webhook Discord.
- [ ] `pr-cfgline` affiche `M:<model sans claude-> · E:<effort> ·
      P:<perm>`. `permissionMode === 'bypassPermissions'` est en couleur
      `--warn`.
- [ ] `pr-cwd` affiche le cwd de la session sélectionnée (pas celui de
      l'orch — vérifier en sélectionnant un worker avec cwd différent).
- [ ] `pr-stats` LOAD = `'—'` (em-dash U+2014, pas hyphen).
- [ ] `pr-stats` UPTIME = `HH:MM:SS` incrémenté par `useNow(5000)` ou
      tick local (vérifier qu'il change toutes les 5 s).
- [ ] `pr-stats` LOG LINES = compteur qui s'incrémente quand l'agent
      produit du PTY output (taper une commande, voir LOG LINES monter).
- [ ] `pr-meta pid · started · last_activity` cohérent avec la session
      (pid numérique, started en HH:MM, last_activity en `Ns ago`
      reactualisé périodiquement).

### 12.2 Actions
- [ ] STOP sur un worker → ConfirmModal apparaît → CONFIRM → session
      passe en `exited` (status chip update à l'auto-refresh `useSession`).
- [ ] STOP sur un lead → ConfirmModal mentionne "the entire team and its
      N workers" → CONFIRM → orch disparaît de `useOrchestrators` au
      prochain poll, RightPanel se ferme (`setSelectedSessionId(null)`).
- [ ] PAUSE sur un worker → session passe en `paused`, chip warm-black
      affiche PAUSED.
- [ ] RESTART sur un worker → nouvelle session apparaît, sélection
      propagée vers `newSession.id`, RightPanel suit (vérifier que le
      `selected.id` change, le PTY se reconnecte).
- [ ] RESTART sur un lead → bouton disabled, tooltip "lead is restarted
      via STOP + recreate".
- [ ] KILL sur un worker → ConfirmModal danger → CONFIRM → session
      `killed` (même endpoint que STOP côté serveur, status visible).
- [ ] KILL sur un lead → ConfirmModal → CONFIRM → orch détruit
      (`destroyOrchestrator`).
- [ ] REACTIVATE sur une session terminée → bouton disabled, tooltip
      "reactivate available in v2".
- [ ] `+ WORKER` sur un lead → bouton actif, click ouvre le state
      `spawnFor` (modale Phase C13 absente en Step 7 — le state change,
      pas de visuel, OK).
- [ ] `+ WORKER` sur un worker → bouton disabled, tooltip "lead-only action".

### 12.3 Tabs
- [ ] CONSOLE : xterm.js monté, fond `#0d0a08`, foreground ambré,
      output PTY visible. Taper du texte → bytes écrits dans le PTY,
      output retourné.
- [ ] Pastille WRITER/READER visible en haut à droite des tabs : WRITER
      sur le premier client connecté à la session, READER sur les
      suivants (tester en ouvrant 2 onglets sur la même session).
- [ ] MESSAGES : si la session a reçu des mails (déclencher un broadcast
      depuis le hub ou depuis un autre lead via swarm.send_to_lead),
      les bulles apparaissent classifiées :
      - `me` (YOU) pour les broadcasts opérateur,
      - `them` (`abc1`) pour les peer intra-team,
      - `system` (SYSTEM) pour les notices serveur,
      - `other-team` (`Atlas / lead-1`) pour les messages cross-team
        (badge "· via Atlas" visible).
- [ ] CONFIG : RUNTIME affiche model/effort/perm/cwd/pid/started.
      Si session `exited/killed/failed/interrupted/stopped` : ligne
      EXIT REASON visible. Si `failed` + lastError : ligne ERROR rouge.
- [ ] CONFIG : LEAD PROMPT, LEAD PREAMBLE, WORKER PREAMBLE affichent
      `'— (none) —'` si non définis, sinon le texte complet.
- [ ] CONFIG : CONNECTORS — chip "ENABLED" + url tronquée si Discord,
      sinon message d'aide.

### 12.4 Composer
- [ ] Mode AGENT + PTY (worker sélectionné) : taper "ls\n" + Cmd+Enter →
      la commande est exécutée dans le PTY (visible dans CONSOLE), draft
      reset à vide.
- [ ] Mode AGENT + INBOX : bouton INBOX disabled, tooltip "v2",
      cliquer ne change pas le mode (reste sur PTY).
- [ ] Mode TEAM (lead seulement) + PTY ou INBOX : taper "go for it" +
      Cmd+Enter → `broadcastToOrchestrator` appelé, mail visible dans la
      tab MESSAGES de chaque session de la team au prochain poll.
- [ ] Toggle TEAM absent sur un worker (audience seg pas rendu si
      `!isLead`).
- [ ] Composer disabled si session `exited/killed/interrupted/failed/stopped` :
      textarea grise, placeholder "agent stopped — reactivate to send",
      bouton SEND grisé.
- [ ] send-target label mis à jour : `BROADCAST → ALL OF <team>` en TEAM,
      `CHANNEL → <agent>` en AGENT.

### 12.5 ConfirmModal
- [ ] Cliquer STOP → modale "STOP SESSION" avec body lead-vs-worker.
      CANCEL ferme la modale sans effet.
- [ ] Cliquer KILL → modale "KILL SESSION" rouge. Backdrop click ferme
      la modale.
- [ ] CONFIRM déclenche l'action et ferme la modale.

### 12.6 Edge cases
- [ ] Session sélectionnée disparaît (destroyed par un autre opérateur) :
      `useSession` ne re-trouve plus la session, `selected` devient `null`
      via `useEffect`. RightPanel rend la version `closed`.
- [ ] Pas de role lié (`orch.roleId === null`) : `selectedRole === null`,
      `team.leadPrompt === null`, chip Discord absent. CONFIG affiche
      `'— (none) —'` partout.
- [ ] Switch rapide entre 2 sessions : `useEffect([selectedSessionId])`
      reset `logLines`, `writer`, `inboxMessages`, `draft`, `composerMode`,
      `audience`, `confirm`. Pas de "fuite" de l'état précédent.
- [ ] Lead avec 0 worker : `workerCount === 0` ; ConfirmModal STOP
      mentionne "0 workers" (cosmétique acceptable, ou améliorer en
      omettant la phrase si 0).

### 12.7 Tests unitaires automatisés (Vitest)
```bash
cd packages/web && pnpm test
```
- [ ] `lib/loadPercent.test.ts` : reste vert (aucun changement).
- [ ] `lib/mailBubble.test.ts` : reste vert (aucun changement).
- [ ] `lib/format.test.ts` (à créer si pas livré Step 2) : `formatUptime`,
      `formatRelative`, `formatClockShort`, `statusLabel`,
      `statusChipClass` — couvrir les cas nominal + null/undefined/NaN.
- [ ] `desktop/rightPanelAdapters.test.ts` (nouveau Step 7) :
      `buildRightPanelTeam` (avec/sans role, avec/sans Discord),
      `buildRightPanelAgent` (load undefined, writer undefined,
      lastError présent).
- [ ] `desktop/Composer.test.tsx` (nouveau Step 7) : INBOX disabled en
      AGENT, tooltip, force-flip vers PTY si on switch vers AGENT en
      mode mailbox.

---

## 13. Récapitulatif — fichiers touchés en Step 7

| Fichier | Type | Modification |
|---|---|---|
| `packages/web/src/components/Terminal.tsx` | EDIT | theme warm-black + props optionnelles `onRoleChange` / `onDataFrame` / `hideChrome` |
| `packages/web/src/components/desktop/ConfigTab.tsx` | EDIT | étend `ConfigTabAgent` avec `stopReason` + `lastError` ; harmonise `stopped` |
| `packages/web/src/components/desktop/Composer.tsx` | EDIT | bouton INBOX disabled si audience AGENT + force-flip défensif |
| `packages/web/src/components/desktop/RightPanel.tsx` | EDIT | étend `RightPanelAgent` (`exitCode`, `stopReason`, `lastError`) ; monte `Terminal` ; utilise `formatLoadPercent` ; désactive REACTIVATE et RESTART du lead |
| `packages/web/src/components/desktop/DesktopShell.tsx` | EDIT | états `logLines/writer/inboxMessages` ; hooks `useRoles/useSession` ; poll inbox 3 s ; callbacks Terminal ; `onAction` + `onSend` ; props passées au `<RightPanel/>` |
| `packages/web/src/components/desktop/rightPanelAdapters.ts` | NEW (optionnel) | `buildRightPanelTeam` + `buildRightPanelAgent` (extraction pour tests) |
| `packages/web/src/components/desktop/rightPanelAdapters.test.ts` | NEW (optionnel) | tests des adapters |
| `packages/web/src/components/desktop/Composer.test.tsx` | NEW (optionnel) | régression INBOX disabled |

**Aucun changement serveur, aucun nouveau endpoint, aucune dépendance npm
ajoutée.** Les 6 gaps §4 (1/2/3/4/5/6/8) restent ouverts ; Step 7 les
rend visibles via tooltips et disabled states cohérents.

---

## 14. Annexe — Tableau récapitulatif Source → Cible

| UI (proto v2) | Source backend | Helper / Adapter |
|---|---|---|
| pr-id `{name} :: LEAD :: {ID}` | `OrchestratorView.name` + `selectedSessionId === leadSessionId` + `SessionView.id` | — |
| pr-name + chip | `SessionView.name` + `SessionView.status` | `statusChipClass`, `statusLabel` |
| pr-role + Discord chip | `SessionView.role` + `RoleView.connectors[type=discord]` | `buildRightPanelTeam.discordWebhook` |
| pr-cfgline | `OrchestratorView.defaultModel/Effort/PermissionMode` | `.replace('claude-', '')` |
| pr-cwd | `SessionView.cwd` (de la session sélectionnée) | — |
| LOAD | `undefined` (S10) | `formatLoadPercent(undefined)` → `'—'` |
| UPTIME | `SessionView.startedAt` | `formatUptime` |
| LOG LINES | accumulé via Terminal callback `onDataFrame` | `setLogLines((n)=>n+1)` |
| pid | `SessionView.pid` | fallback `'—'` |
| started | `SessionView.startedAt` | `formatClockShort` |
| last_activity | `SessionView.lastActivityAt` | `formatRelative` |
| STOP (lead) | `api.destroyOrchestrator(orchId)` | `ConfirmModal` |
| STOP (worker) | `api.stopSession(id)` | `ConfirmModal` |
| PAUSE | `api.pauseSession(id)` | — |
| RESTART (worker) | `api.restartSession(id)` → propager `newSession.id` | — |
| RESTART (lead) | disabled (S5 409) | tooltip |
| KILL (lead) | `api.destroyOrchestrator(orchId)` | `ConfirmModal` |
| KILL (worker) | `api.stopSession(id)` (gap §4-6) | `ConfirmModal` |
| REACTIVATE | disabled (gap §4-8) | tooltip "v2" |
| + WORKER | `setSpawnFor(team)` → `SpawnWorkerDialog` (Phase C13) | gap §4-3, preview |
| Edit cfgline | `setEditConfigFor(team)` → `EditConfigDialog` (Phase C13) | gap §4-2, preview |
| Tab CONSOLE | `<Terminal sessionId={selected.id} hideChrome />` | callbacks `onRoleChange`, `onDataFrame` |
| Pastille WRITER/READER | `selected.writer` (depuis hello frame WS) | — |
| Tab MESSAGES | `peekInbox(orchId, sessionId)` poll 3 s → `classifyBubble` | `buildMessageBubbles` |
| Tab CONFIG RUNTIME | `OrchestratorView` + `SessionView` + `exitCode/stopReason/lastError` | `ConfigTab` |
| Tab CONFIG LEAD PROMPT | `RoleView.leadPrompt` (via `getRole(orch.roleId)`) | fallback `'— (none) —'` |
| Tab CONFIG LEAD PREAMBLE | `OrchestratorView.leadPreamble` | — |
| Tab CONFIG WORKER PREAMBLE | `OrchestratorView.workerPreamble` | — |
| Tab CONFIG CONNECTORS | `RoleView.connectors` | — |
| Composer AGENT/PTY | `api.postSessionInput(id, text + '\n')` | — |
| Composer AGENT/INBOX | disabled (gap §4-5) | tooltip |
| Composer TEAM/PTY ou INBOX | `api.broadcastToOrchestrator(orchId, text)` | lead-only |

— FIN du document analyse Step 7 —
