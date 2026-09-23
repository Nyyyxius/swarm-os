# Auto-compact à seuil de contexte — par rôle, à la frontière d'inactivité

Plan de la fonctionnalité. Statut : **Lots 1a, 1b, 2 et 3 livrés
(2026-09-14)** — plan validé par revue adversariale (3 relecteurs : exactitude
vs code, mécanisme, design, deux passes), code relu (read-only) et corrigé ;
§7 en garde la trace. Reste à faire : la vérification Docker du §5 sur une
team réelle (non exécutée — redéploiement du conteneur 24/7 à la main de
l'opérateur).

Les ancres `fichier:ligne` pointent dans `packages/server/src/` (serveur) et
`packages/web/src/` (web), état de l'arbre de travail au 2026-09-14.

---

## 1. Principe demandé

> Ajouter un principe d'auto-compact lorsque le contexte d'un agent dépasse
> 35 % (configurable par rôle), dès que l'agent n'a plus de travail en cours et
> qu'il n'a plus de messages en attente. Après un compact, s'assurer que les
> messages en attente soient traités.

Quatre conditions, une action, une garantie :

| # | Condition / action | Source de vérité existante |
|---|---|---|
| C1 | contexte ≥ seuil (35 % défaut, par rôle) | `ContextUsageTracker.snapshot().pct` — **fraction 0..1** (`orchestrator/context-usage.ts:1640-1650`) |
| C2 | plus de travail en cours | PTY silencieux ≥ `idleThresholdMs` (2 s) — même définition que la mailbox (`orchestrator/messaging.ts:149-157 isIdle`), le tir des resets (`orchestrator/session.ts:1339-1368`) et les notices opérateur (`session.ts:1555-1593`) |
| C3 | plus de messages en attente | `Mailbox.size(sid) === 0` (`orchestrator/mailbox.ts:384`) |
| A | armer `/compact` | `Session.requestContextReset('/compact', { idleMs, instructions })` (`session.ts:1307-1327`) — mono-occupant, tir à l'idle, préambule durable par provider |
| G | après le compact, les messages en attente sont traités | re-signal de l'inbox, aujourd'hui limité à `/clear` + `setTimeout(2000)` (`orchestrator/index.ts:1064-1082`) |

## 2. Constat (état actuel)

Tout le matériel existe, mais rien ne relie C1 à C2/C3 :

- **Mesure de contexte** : un tracker par session (claude = transcript
  `.jsonl` via hook `SessionStart`, codex = rollout, opencode = plan de
  contrôle, **gemini = rien**). Le seul appelant de `maybeRefreshContextUsage`
  est `Orchestrator.toView()` (`index.ts:1464`), qui n'a aucun appelant
  périodique hors le poll UI 3 s : sans onglet ouvert, aucun échantillon n'est
  lu. TTL `SWARM_OS_CONTEXT_USAGE_TTL_MS` (15 s), cap global 4 lectures
  simultanées (`context-usage.ts:94`), garde de génération, `stale` après reset.
- **Après `/compact`, le source claude ne s'invalide pas.** `markStale()`
  (`context-usage.ts:1530-1539`) bascule le flag et appelle
  `source.invalidate?.()`, que seuls codex (`context-usage-codex.ts:692`) et
  opencode (`context-usage-opencode.ts:414`) implémentent. Le transcript claude
  est réécrit **en place** (spike `scripts/verify-claude-sessionstart.report.md:228,288`),
  le curseur rattrapé ressert `#gauge` (`context-usage.ts:907-913`), et
  `#run` accepte ce chiffre **pré-compaction** comme `stale:false`
  (`:1727-1734`). Tout usage de la mesure post-reset doit en tenir compte.
- **Deux backstops automatiques, tous deux OFF par défaut** et aveugles au
  contexte réel : `SWARM_OS_AUTO_COMPACT_BYTES` (`session.ts:1691-1702`) et
  `SWARM_OS_COMPACT_ON_WAITING` (`http/routes/hooks.ts:523-534`). Ce dernier
  est inopérant pour codex/gemini (en-tête de `hooks.ts:27-45`, trois
  objections motivées : redondance, cadence/coût, boucle auto-entretenue).
- **Le chemin primaire est agent-driven** : `team.context_compact` /
  `team.context_clear` / `team.clear_worker` (`mcp/tools.ts:751-841`) et les
  préambules (`preambles/default-lead.md:195`, `default-worker.md:131`).
  En pratique les agents oublient — d'où la demande.
- **Frontière d'inactivité** : aucun événement « l'agent vient de passer
  idle ». `_idleSince` est posé à chaque octet PTY (`session.ts:2007-2020`)
  et lu paresseusement par des timers armés à la demande. Un message qui
  arrive **pendant** un tour n'est jamais signalé (`messaging.ts:230`, et
  toutes les variantes `:280, 413, 466, 536, 581`) — incident documenté dans
  `session.ts:1464-1479`. Le préambule compense en demandant aux agents de
  poller.
- **Six sites tapent le signal d'inbox** : `messaging.ts:166` (`injectSignal`),
  `index.ts:1072` (`_onSessionContextReset`), `index.ts:1710` (copie
  **littérale** du texte, pas la constante), `spawner/index.ts:419`,
  `skills/activation.ts:144`, `orchestrator/mailbox-persistence.ts:174`. Aucun
  n'est protégé contre un reset en cours de frappe (`_contextResetFiring`,
  fenêtre 250 ms) ni contre un dialogue affiché.
- **Dialogues** : une session claude en mode *prompting* affichant un dialogue
  de permission est idle ; `hooks.ts:412-422` n'émet qu'un événement UI, le
  statut reste `running`. Toute ligne injectée + `\r` y **valide l'option
  surlignée**. Le hook `Notification` porte `notification_type`
  (vérifié dans le binaire claude 2.1.270 : schéma
  `{hook_event_name:"Notification", message, title?, notification_type}` ;
  valeurs connues `permission_prompt`, `idle_prompt` (« Claude is waiting for
  your input »), `auth_success`, `elicitation_dialog`, `agent_needs_input`,
  `agent_completed`). Le serveur ne le lit pas aujourd'hui.
- **Rôles** : gabarit d'un réglage numérique par rôle consommé à chaud =
  `autoRemoveDeadWorkersDelayMs` (colonne `db/index.ts:923`, `RoleRow`
  `:152`, INSERT/UPDATE `:783-818`, type `roles/index.ts:278`, validation
  `http/routes/roles.ts:223`, `RoleBody` `:78-92`, UI
  `components/RolesPage.tsx:1121 AutoCleanupSection` montée en `:435`,
  `RoleDialog.tsx:43-44, 443-456`, type `api/client.ts:379-384 RoleView`).

## 3. Cible

### 3.1 Décisions d'architecture

**D1 — Un seul événement nouveau : la frontière d'inactivité (`onIdle`).**
`Session` émet `onIdle(session)` **une fois par période de silence**, quand le
PTY est resté muet `idleThresholdMs`. Implémentation calquée sur
`_scheduleContextReset` (`session.ts:1339-1368`) : **un timer par session au
plus**, armé au premier octet d'une rafale **seulement s'il n'en existe pas
déjà un** (pas de clear+set à chaque chunk), dimensionné sur le temps d'idle
restant, ré-armé s'il se réveille alors que l'agent parle encore, `unref()`.
`_idleNotified` empêche un second tir pour la même période et retombe au
prochain octet PTY. Le timer est aussi armé — **en remettant `_idleNotified`
à `false`**, sinon ces sites seraient des no-op — depuis `resume()`
(`session.ts:1832`, qui ré-arme aussi un reset parqué), depuis le passage à
`running` au spawn (`:2005`), depuis `writeInput`/`submitInput` quand ils
lèvent `dialogPending` (D5), à la fin de la branche « provider sans reset »
de `_fireContextReset` (`:1379-1390`), et depuis `_resolveNotice`
(`:1624-1657`) pour toute issue autre que `fired` (`cancelled`, `never_idle`,
`no-agent` : la notice avait pris la frontière, rien d'autre ne la rendrait) —
sinon un agent qui ne produit plus d'octet n'aurait plus jamais de frontière.
Il est libéré dans `_handleExit` (`:2068-2073`) et sur le chemin `stop()`
sans agent (`:1738-1749`) ; son callback ne fait rien hors `running|waiting`
(`paused` n'est jamais idle — `messaging.ts:155`). Un agent `resume()`-é dont
le PTY reste muet est évalué à cette frontière-là, puis seulement à sa
prochaine fin de tour.

Pourquoi ce point d'accroche : le hook `Notification` claude signifie
« bloqué sur un humain » ou « idle depuis 60 s » — l'inverse de « libre de
compacter » ; codex/gemini ont `turn-complete` mais gemini n'a pas de tracker
et opencode ne rappelle rien (`providers/types.ts NotificationHookSemantics`) ;
un hook `Stop` claude serait claude-only et toucherait la chaîne shell de
hook « production-critical » (`providers/session-config.ts:164-165`). Le
silence PTY est le seul signal uniforme aux quatre providers et il est déjà
la définition d'« idle » partout. Les TUI redessinent un spinner tant qu'un
tour est en cours : 2 s de silence = prompt affiché. Alternative écartée :
faire porter l'évaluation par le tick 60 s du reaper — G exige quand même une
frontière, et un mécanisme qui sert les deux vaut mieux qu'un tick + une
notice.

**D2 — Le handler de frontière est synchrone et fait, dans cet ordre :**

0. **porté par `Session` elle-même, dans le callback du timer, avant
   d'appeler `onIdle`** : rien hors `running|waiting` ; rien si
   `dialogPending` (D5) ; rien si un reset est armé ou en cours de frappe
   (`hasPendingContextReset`, `session.ts:1455-1462`) ou si une notice
   opérateur est armée (`session.ts:1671`). Dans ces cas `_idleNotified`
   **n'est pas** posé : la frontière n'est pas consommée, elle reviendra par
   l'écho du reset, par `writeInput` ou par `_resolveNotice` (D1). Tous ces
   états sont ceux de la Session : l'orchestrateur ne voit que des frontières
   « libres » ;
1. **signal d'inbox** — si `mailbox.size(sid) > 0` et
   (`session.lastInboxSignalAt === null` ou `mailbox.newestTs(sid) >
   session.lastInboxSignalAt`) → `session.signalInbox()`. C'est la garantie
   G : le re-signal post-`/compact` a lieu **quand la compaction est finie**
   (le PTY redevient muet), pas sur un timer. `_fireContextReset` remet
   `lastInboxSignalAt` à `null` au moment où la commande atteint le PTY : une
   seule règle couvre « message arrivé après le dernier signal » **et**
   « reset depuis ». Effet voulu : un message arrivé pendant un tour est
   signalé à la fin du tour — le trou de `messaging.ts:230` se ferme.
   Anti-spam : au plus **un rappel par message** (un agent qui ignore son
   inbox n'est pas relancé à chaque frontière). Le `setTimeout(2000)` de
   `_onSessionContextReset` disparaît ;
2. **décision auto-compact** (D3) sur le `snapshot()` synchrone — **exécutée
   même si l'étape 1 vient de signaler** (elle répond alors `inbox-pending`,
   ce qui alimente le log « une fois par changement de raison ») ; si la raison
   est `inbox-pending`, la même fonction pure est rejouée avec `inboxCount: 0`
   et, si cette seconde réponse est `fire`, un `warn`
   `session.auto_compact_starved` est émis une fois par session (jusqu'au
   prochain tir) : C3 affame C1, l'agent n'a jamais lu son inbox ; puis si
   `fire` : `requestContextReset('/compact', { idleMs, instructions:
   AUTO_COMPACT_INSTRUCTIONS })` — il tire à la frontière suivante, c'est-à-dire
   tout de suite si l'agent est toujours idle, ou après le tour en cours si un
   message l'a réveillé entre-temps ;
3. `session.maybeRefreshContextUsage()` (fire-and-forget, TTL 15 s) pour que
   la frontière suivante dispose d'un échantillon plus frais. **Pas de
   `refresh()` forcé** : `markStale()` et `retarget()` rouvrent déjà le TTL
   (`context-usage.ts:1509, 1533`), et un échantillon vieux de ≤ 15 s décale
   la décision d'au plus une frontière — en retard, jamais à tort, puisque le
   contexte ne fait que croître entre deux resets. Cela garde le rythme de
   lecture SSH borné par le TTL, comme aujourd'hui.

**D3 — La décision est une fonction pure** (`orchestrator/auto-compact.ts`,
nouveau). Contrat exact :

```ts
export const AUTO_COMPACT_MIN_GROWTH_PCT = 10; // points de fenêtre
export const AUTO_COMPACT_INSTRUCTIONS: string; // une ligne, sans \r ni \n, voir D8

export interface AutoCompactInput {
  thresholdPct: number;            // 0..100 ; 0 = off
  usage: ContextUsageView | null;  // Session.contextUsage (snapshot)
  floorTokens: number | null;      // ContextUsageTracker.floorTokens
  inboxCount: number;              // mailbox.size(sid)
  resetPending: boolean;           // session.hasPendingContextReset
  dialogPending: boolean;          // session.dialogPending
}

export type AutoCompactSkipReason =
  | 'disabled' | 'reset-pending' | 'blocked' | 'inbox-pending'
  | 'no-usage' | 'stale' | 'below-threshold' | 'not-grown';

export type AutoCompactDecision =
  | { fire: true; pct: number }                 // pct entier 0..100
  | { fire: false; reason: AutoCompactSkipReason };

export function decideAutoCompact(input: AutoCompactInput): AutoCompactDecision;
```

Gardes, dans l'ordre d'évaluation :

| reason | garde |
|---|---|
| `disabled` | `thresholdPct <= 0`, **ou non entier / non fini** (`Number.isInteger` — 14 fichiers de tests construisent des `Config` partiels où `config.autoCompactPct` vaut `undefined` ; `undefined <= 0` est `false` et tout tomberait au tir) |
| `reset-pending` | mono-occupance (`session.ts:1455-1462`) |
| `blocked` | `dialogPending` (D5) |
| `inbox-pending` | C3 |
| `no-usage` | `usage === null` ou `usage.pct === null` (gemini, TTL 0, limite de modèle inconnue → jamais de chiffre inventé) |
| `stale` | `usage.stale` |
| `below-threshold` | `Math.round(usage.pct * 100) < thresholdPct` — **`pct` est une fraction 0..1** |
| `not-grown` | **anti-boucle** : `floorTokens !== null && usage.usedTokens − floorTokens < AUTO_COMPACT_MIN_GROWTH_PCT / 100 × usage.limitTokens` |

`floorTokens` = **minimum** des `usedTokens` acceptés depuis le dernier
bump de génération du tracker (`markStale()` **et** `retarget()`, qui le
remettent à `null`). Le minimum, pas le premier échantillon : sur claude le
premier échantillon « non-stale » après `/compact` est le chiffre
**pré-compaction** (§2) ; avec « premier », le socle se figerait au pic
précédent et le seuil effectif dériverait de +10 points à chaque compaction
jusqu'à ne plus jamais tirer. Avec le minimum, ce chiffre bogus donne
`croissance 0 → not-grown` à la frontière post-compaction, puis le premier vrai
tour rabaisse le socle. Un `/compact` refusé par le CLI (« Not enough
messages », aucun hook — spike S1d) relit la même ligne → croissance 0 → pas
de re-tir. Si le socle post-compaction (system prompt + outils MCP + résumé)
dépasse lui-même le seuil, l'agent est re-compacté tous les 10 points de
croissance, jamais sur place : c'est la réponse à l'objection 3 de
`hooks.ts` (boucle), et la cadence répond à l'objection 2 (coût). Pas de
cooldown temporel : il ne ferait que masquer un défaut de `not-grown`, et
60 s est de l'ordre d'une compaction.

**D4 — Aucune API de lecture nouvelle sur le tracker.** Seulement un getter
`floorTokens` (min depuis le dernier bump de génération, `null` sinon).
`snapshot()`, `maybeRefresh()`, TTL, cap 4 et gardes de génération sont
inchangés. Un ajout d'une ligne dans `hooks.ts`, branche `session.transcript`
(`:356-366`) : quand le payload `SessionStart` porte `source` ∈ `{compact,
clear}`, appeler `session.markContextStale()` (→ `tracker.markStale()`). Cela
re-base le socle pour les compactions que le serveur n'a pas tirées — le
**compact automatique interne de Claude Code** (qui tire en plein tour, à
l'insu du serveur, et violerait sinon la prémisse « le contexte ne fait que
croître entre deux resets » : un snapshot ≥ seuil hérité de la frontière
précédente aurait tiré un `/compact` redondant sur un contexte tout frais)
et un `/compact` tapé à la main dans la console. Pour un reset serveur, c'est
un second bump inoffensif (socle déjà `null`, déjà `stale`). Limite connue et pré-existante : la jauge claude affiche le
chiffre pré-compaction jusqu'au tour suivant ; un `invalidate()` sur le source
claude (mémoriser le `timestamp` de la dernière ligne assistant servie et
répondre `empty` tant que rien de plus récent n'apparaît, comme codex
`context-usage-codex.ts:735-743`) corrigerait la jauge — hors périmètre, la
décision n'en dépend pas.

**D5 — Ne jamais taper dans un dialogue : `Session.dialogPending`.**
Rejeté : une garde par le store d'approbations. `hooks.ts:442-463` crée une
demande `pending` pour **chaque** notification `needs-human` d'une session en
mode prompting, `idle_prompt` compris (aucun filtre sur le type, aucune
déduplication — `approvals/store.ts:466-505`), et personne ne la résout : la
garde aurait répondu `blocked` à vie. À la place :

- `hooks.ts`, branche `needs-human` (`:412-422`) : lire `notification_type`
  via `readStringField(payload, 'notification_type')` (`hooks.ts:159-169`).
  Listes relevées dans les binaires **2.1.142** (épinglé dans l'image) et
  **2.1.270** (hôte) — la liste grandit surtout avec des types informatifs :
  - **bloquants** (un dialogue attend un humain) → `session.markDialogPending(type)` :
    `permission_prompt`, `worker_permission_prompt`, `elicitation_dialog`,
    `elicitation_url_dialog`, `agent_needs_input` ;
  - **fin de dialogue** → `session.clearDialogPending('elicitation')` :
    `elicitation_complete`, `elicitation_response` (couvre l'élicitation MCP
    fermée sans frappe) ;
  - **informatifs** → rien : `idle_prompt`, `auth_success`, `agent_completed`,
    `push_notification`, `computer_use_enter`, `computer_use_exit`,
    `quota_auto_resume_fired`, `quota_auto_resume_stale`,
    `quota_auto_resume_disabled` ;
  - **inconnu** → fail-closed **seulement** si `isPromptingMode(providerId,
    session.permissionMode)` (un dialogue y est possible), rien sinon (geler le
    courrier d'une flotte bypass sur un futur type informatif serait la vraie
    régression) ; `warn hooks.notification_type_unknown { notificationType }`
    une fois par type.
  Le drapeau est **posé avant** l'émission de l'événement `waiting` pour
  qu'une automatisation branchée sur le bus ne réponde pas avant qu'il
  existe. Champ **absent** (CLI antérieur à ceux vérifiés) → repli
  `isPromptingMode(providerId, session.permissionMode)`
  (`approvals/prompting.ts:35-48` : claude ∧ `default|plan|acceptEdits`) — la
  question est « ce mode affiche-t-il des dialogues », pas « ce rôle veut-il
  des approbations » ; `shouldArmApproval` honore `armingModes` d'un rôle, qui
  peut lister `bypassPermissions` (`http/routes/roles.ts:185`) et aurait
  bloqué toute une flotte bypass sur un `idle_prompt` sans type. Log
  `hooks.dialog_pending { notificationType }`.
- Levé dans `writeInput` (`session.ts:1162`) et `submitInput` (`:1184`) —
  console web (`http/ws/terminal.ts:80,89,107`), REST
  (`http/routes/sessions.ts:74-76`) et réponses Discord
  (`approvals/resolve.ts:115-116`) y passent tous, seuls appelants
  d'`agent.write` hors `session.ts`. **Jamais levé sur sortie PTY** : un
  resize redessine le dialogue, et lever au premier octet rouvrirait la
  fenêtre d'auto-validation au moment précis où l'opérateur ouvre la console.
  En levant le drapeau, `writeInput`/`submitInput` ré-arment
  `_scheduleIdleCheck()`, `_scheduleContextReset()` et `_scheduleNotice()`.
  Un dialogue fermé sans frappe (élicitation MCP annulée par timeout) laisse
  le drapeau levé jusqu'à la prochaine frappe : `warn` une fois quand il a
  plus de 10 min (`session.dialog_pending_stale { ageMs }`), pas de levée
  automatique.
- Consulté par **toutes** les injections serveur : `signalInbox()` (refuse et
  ne stampe pas), le tir des resets (`_scheduleContextReset` : si
  `dialogPending` **ou `paused`**, ne pas tirer ni ré-armer — `writeInput` /
  `resume()` ré-armeront ; couvre aussi `team.context_compact`,
  `team.clear_worker`, le bouton COMPACT et les deux backstops ; le cas
  `paused` est un défaut pré-existant — un reset armé avant `pause()` tirait
  dans un PTY SIGSTOP'é et arrivait collé en un seul chunk au SIGCONT, non
  soumis, alors que `markStale`/`recordReset` avaient déjà couru — réparé ici
  puisque la fonction est touchée), et les notices (`_scheduleNotice` :
  traité comme `lineHeld` → backoff jusqu'à la deadline → `never_idle`,
  sémantique honnête : personne n'a été prévenu, raison distincte
  `deadline-dialog-pending` à côté des deux raisons existantes de
  `session.ts:1583`). Visibilité opérateur : ligne de log session
  `[swarm-os] context /compact held — dialog pending` (une fois par reset
  retenu), sinon « retenu » et « planté » sont indiscernables depuis le
  bouton COMPACT, qui répond `scheduled` et garde son badge. Le repli « champ
  absent » est loggé `warn` une fois par session
  (`hooks.dialog_pending_untyped`) : s'il est pris, une session prompting
  reçoit un `idle_prompt` non typé après 60 s d'idle et gèle signal, resets
  et notices jusqu'à une frappe — régression par rapport à aujourd'hui, à
  ne jamais laisser silencieuse. Vitesse de la garde = latence du POST du hook
  (curl sur l'hôte de l'agent), très inférieure à la fenêtre d'idle de 2 s ;
  le rendu du dialogue lui-même est de la sortie PTY, donc aucun reset ne
  peut se glisser dans un dialogue dont le hook n'a pas encore atterri.
- Couvre `AskUserQuestion`/élicitation en bypass dès lors que le CLI émet un
  `Notification` typé (`agent_needs_input`), ce que la version 2.1.270 fait.
  Sessions codex/gemini/opencode : jamais de `needs-human` → jamais bloquées
  (elles n'affichent pas de dialogue de permission en `bypass`).

**D6 — Résolution du seuil à chaud, sans cache.** À chaque frontière :
`roleStore.get(orch.roleId)?.autoCompactPct ?? config.autoCompactPct`. Une
modification du rôle s'applique à la frontière suivante de chaque agent, sans
redémarrage (24/7). Sémantique : `null` = hérite de l'instance ; `0` =
désactivé pour ce rôle ; `1..100`. Instance : `SWARM_OS_AUTO_COMPACT_PCT`,
défaut **35**, `0` = coupe-circuit flotte ; valeur non entière ou hors
0..100 → 35 + `warn` au boot. Le réglage instance en base
(`instance_settings` + SETTINGS) est **hors périmètre** ; `GET /roles`
exposant `defaults.autoCompactPct` (§3.3) rend ce déplacement futur invisible
pour le web. Les deux backstops existants restent tels quels, requalifiés
« secondaires ».

**D7 — Câblage par dépendances injectées.** `OrchestratorDeps.autoCompact?:
{ thresholdPctFor(roleId: string | null): number }` (`index.ts:137`, même
style que `skills`/`features`) ; absent ⇒ `config.autoCompactPct`. Le
`Spawner` le construit aux deux sites `new Orchestrator` (`spawner/index.ts:524,
1092`) depuis `roleStore` (`:262`). Les trois sites `new Session(…)`
(`index.ts:623, 773, 956`) reçoivent `onIdle: (s) => this._onSessionIdle(s)`.
La garde dialogue est un état de `Session`, sans dépendance.

**D8 — Visibilité et qualité du résumé.**
- Ligne de log session `[swarm-os] auto-compact armed — context 41% ≥ 35%`
  (même canal que `context /compact armed`, `session.ts:1321-1323`, visible
  dans la console).
- Log structuré `info` `session.auto_compact_armed { sessionId, pct,
  thresholdPct, floorTokens }` ; refus loggés `info`
  `session.auto_compact_skipped { sessionId, reason, pct? }` **une fois par
  session et par changement de raison** (« pourquoi mon agent ne compacte
  pas » : `blocked`, `no-usage`), `debug` sinon ; `warn` throttlé quand
  `inbox-pending` bloque un tir qui aurait eu lieu (C3 qui affame C1 : un
  agent qui n'a jamais lu son inbox).
- Événement bus `session.auto_compact`, sous-union
  `AutoCompactSwarmEventKind` à côté de `BudgetSwarmEventKind`
  (`events.ts:79`), payload `{ pct: number; thresholdPct: number }`. **Pas de
  toast** dans ce lot (bruit sur une flotte 24/7) ; le badge
  `contextResetPending` existant couvre l'UI.
- `AUTO_COMPACT_INSTRUCTIONS` (constante serveur, jamais d'entrée utilisateur
  ou agent, **une seule ligne** — un `\r` soumettrait la commande à moitié) :
  `swarm-os auto-compact: keep your role, your current assignment and its exact state, every teammate or session id you talk to and what you asked of each, open decisions, and anything you still owe a reply to; after compaction, call team.read_inbox before anything else.`
  claude et gemini la transmettent (`/compact <texte>`), codex et opencode la
  laissent tomber (`codex.ts:719-720`, `opencode.ts:940-951`) — inoffensif.

### 3.2 Contrat serveur (noms exacts)

`orchestrator/session.ts`
- `SessionInit.onIdle?: (session: Session) => void`.
- `get dialogPending(): boolean` ; `markDialogPending(notificationType: string): void` ;
  levé dans `writeInput`/`submitInput`.
- `export const SIGNAL_TEXT` **déménage ici** (`messaging.ts` le ré-exporte —
  `messaging.ts` n'importe `Session` qu'en `import type`, pas de cycle).
- `signalInbox(): boolean` — `false` sans écrire si `dialogPending`,
  `_contextResetFiring`, `_noticeFiring` **ou `_signalFiring`** (deux
  `sendMessage` à 50 ms d'écart entrelacent aujourd'hui `texte1 texte2 CR CR`
  en une soumission garbled — `messaging.ts:230` par push ; refuser ne coûte
  rien, le second message est re-signalé à la frontière puisque son `ts`
  dépasse le stamp) ; sinon `notifySignal(SIGNAL_TEXT)`, stampe
  `lastInboxSignalAt = Date.now()`, `true`. `get lastInboxSignalAt():
  number | null`. `_fireContextReset` remet le stamp à `null` (juste avant
  `_onContextReset`). `_fireNotice` continue d'appeler `notifySignal`
  directement, **sans stamp**.
- `_signalFiring` : levé par `notifySignal` pendant la fenêtre du deuxième
  `\r` (150 ms) — donc jamais pour un provider `inkSubmitDance: false`
  (écriture unique) ; `_scheduleContextReset` (`:1358`) et `_scheduleNotice`
  (`:1575`) le traitent comme `_noticeFiring` (backoff
  `PTY_INJECT_CONTENTION_RETRY_MS`).
- `lastAutoCompactSkipReason: AutoCompactSkipReason | null` (état du log
  « une fois par changement de raison », remis à `null` au tir) et
  `autoCompactStarvedWarned: boolean` (D2 étape 2) — portés par la Session,
  ils meurent avec elle.
- `markDialogPending(type)` mémorise `type` ; `clearDialogPending(source)`
  (`'input'` depuis `writeInput`/`submitInput`, `'elicitation'` depuis le hook)
  lève le drapeau et ré-arme frontière, reset et notice ;
  `session.auto_compact_skipped { reason: 'blocked' }` porte
  `notificationType`.
- `_scheduleIdleCheck()` / `_idleTimer` / `_idleNotified` (D1) ;
  `markContextStale(): void` (D4).

`orchestrator/mailbox.ts` — `newestTs(sid): number | null` (epoch ms du
message le plus récent en file, `Date.parse(ts)` ; `ts` est ISO,
`mailbox.ts:32, 221`). Les rangées réhydratées gardent leur `ts` d'origine :
plus ancien que tout stamp, mais `mailbox-persistence.ts:174` les signale
lui-même via `signalInbox()`.

`orchestrator/context-usage.ts` — `get floorTokens(): number | null`.

`orchestrator/auto-compact.ts` — D3.

`orchestrator/index.ts` — `OrchestratorDeps.autoCompact` (D7) ;
`_onSessionIdle(session)` (D2) ; `_onSessionContextReset` sans timer ; les
sites `index.ts:1072, 1710` passent par `session.signalInbox()`.
`messaging.ts:164-176 injectSignal`, `spawner/index.ts:419`,
`skills/activation.ts:144`, `mailbox-persistence.ts:174` idem.

`http/routes/hooks.ts` — D5 (`markDialogPending` avant l'événement
`waiting` `:417-422`, donc avant le bloc `compactOnWaiting` `:523-534` : un
backstop armé sur cette notification est retenu d'emblée) et D4
(`session.transcript` + `source`).

`events.ts` — `AutoCompactSwarmEventKind = 'session.auto_compact'`,
`AutoCompactEventPayload { pct: number; thresholdPct: number }`.

`config.ts` — `autoCompactPct: number` (D6).

### 3.3 Modèle de données et API HTTP

- Colonne additive `roles.auto_compact_pct INTEGER` (NULL = hérite, sans
  DEFAULT — même raisonnement que `cost_budget_usd`, `db/index.ts:924-932`) ;
  migration dans le bloc `db/index.ts:922-933` ; `RoleRow.auto_compact_pct:
  number | null` (`:152`) ; INSERT/UPDATE (`:783-818`). Fixtures `RoleRow`
  littérales à compléter (`auto_compact_pct: null`) :
  `db/provider-migration.test.ts:303-358` (trois objets — `tsc` exclut les
  tests, better-sqlite3 lèverait « Missing named parameter » à l'exécution).
- `roles/index.ts` : `Role.autoCompactPct: number | null` ; `RoleInit` /
  `RolePatch` ; `rowToRole` **assainit** (non entier ou hors 0..100 → `null`,
  jamais un seuil arbitraire — pattern `costBudgetUsd`) ; `create` (défaut
  `null`) ; `update` (`null` explicite = retour à l'héritage).
- `http/routes/roles.ts` : `RoleBody.autoCompactPct?: unknown` (`:78-92`) ;
  `parseAutoCompactPct(x)` : `null` ou entier `0..100`, sinon 400
  `autoCompactPct must be null or an integer between 0 and 100` (rejette
  `"35"` et `3.5`) ; branché en POST (`:589-631`) et PATCH (`:752-768`).
  `GET /roles` (`:506-513`) → `{ roles, defaults: { autoCompactPct } }`
  (additif ; `maskRole` spread `:438-440` laisse passer le champ ; le routeur
  reçoit la valeur instance en option). Précédent : `GET /providers`
  (`providers.ts:11-13`).

### 3.4 Préambules

`default-lead.md` (§ « Context management ») et `default-worker.md` : un
paragraphe — le serveur peut vous compacter **automatiquement** quand votre
contexte dépasse le seuil de votre rôle (35 % par défaut), uniquement quand
vous êtes idle avec une inbox vide, jamais au milieu d'un tour ; après
**toute** compaction, appelez `team.read_inbox` en premier (le serveur
re-signale l'inbox si du courrier attend, mais la règle « après chaque tâche,
lire l'inbox » reste la vôtre).

### 3.5 UI (web)

- `api/client.ts` : `RoleView.autoCompactPct?: number | null` (`RoleInput`
  en dérive, `:428`) ; `listRoles(): Promise<{ roles: RoleView[]; defaults?:
  { autoCompactPct: number } }>` (`:1791` ; optionnel — mocks existants
  `NewOrchestratorDialog.test.tsx:128,444` ne renvoient que `roles`). Le
  défaut d'instance descend par `hooks/useRoles.ts` (état
  `autoCompactDefaultPct`, repli `DEFAULT_AUTO_COMPACT_PCT = 35`) ; la moitié
  pure (parse strict entier 0..100, `autoCompactSummary`) vit dans
  `lib/autoCompact.ts`, miroir de `lib/budget.ts`, testée dans
  `lib/autoCompact.test.ts` (pas de harnais `RolesPage` : la page monte trois
  hooks et trois fetches).
- `RolesPage.tsx` : section **AUTO-COMPACT** (clone structurel
  d'`AutoCleanupSection` `:1121`, montée avec les autres `:435`) : lecture =
  `Hérite (35 %)` / `50 %` / `Désactivé` ; édition = `<input type="number"
  min=0 max=100>` vide = hérite, `0` = off ; aide : « Le serveur arme
  `/compact` quand le contexte dépasse ce pourcentage, seulement quand l'agent
  est idle avec une inbox vide. En dessous du socle post-compaction (≈ 15-20 %
  sur claude), l'agent est re-compacté tous les 10 points de croissance. » ;
  `duplicateRole` (`:220-225`) recopie le champ.
- `RoleDialog.tsx` : même champ sous RETRAIT AUTO (`:443-456`), **toujours
  envoyé** y compris `null` (pattern `costBudgetUsd`, `:291`).

### 3.6 Ce qui ne change pas

- `requestContextReset`, `_fireContextReset`, la mono-occupance, le rendu
  `contextResetLine` par provider.
- Le poll UI 3 s, `maybeRefresh()`, TTL, cap 4, facturation Lot 11 (le
  curseur est sérialisé par `#inFlight`, aucune lecture nouvelle).
- Les outils MCP et le chemin agent-driven : un agent qui compacte lui-même
  arrive à la frontière avec `reset-pending`, puis `stale`/`not-grown` —
  aucun double compact. Les autres sources de reset (bytes, waiting, MCP,
  opérateur) passent toutes par `_fireContextReset` → `markStale` → le socle
  est re-basé pour elles aussi.
- Badge `waiting`, Discord, approbations : `hooks.ts` gagne une lecture de
  champ et un appel, rien d'autre.

### 3.7 Changements de comportement (à connaître)

1. **ON par défaut à 35 %** pour tout rôle sans valeur, sur claude/codex/
   opencode. Une lead idle en attente d'un worker est compactée avant la
   réponse — c'est exactement ce que `team.context_compact` lui demande déjà
   de faire elle-même ; la qualité du résumé repose sur
   `AUTO_COMPACT_INSTRUCTIONS`. Coupe-circuit : `SWARM_OS_AUTO_COMPACT_PCT=0`
   ou `0` sur le rôle.
2. **Un message arrivé pendant un tour est signalé à la fin du tour** (crons,
   ponts Discord/plugins inclus : un tick de cron réveille la lead à la fin de
   son tour au lieu d'attendre son prochain poll). Au plus un rappel par
   message.
3. **Rien n'est tapé dans un dialogue** : signal d'inbox, resets (toutes
   sources) et notices sont retenus tant qu'un dialogue est affiché et
   repartent à la première frappe humaine.
4. Le re-signal post-`/clear` passe d'un timer 2 s à la frontière suivante
   (même latence en pratique) et couvre désormais `/compact`.

### 3.8 Cas limites tranchés

- **Gemini** : pas de tracker → `no-usage`, jamais de tir ; `—` dans l'UI.
- **SSH** : aucune lecture nouvelle ; une lecture ratée ⇒ `stale` ⇒ pas de
  tir, réessai au TTL.
- **Même frontière qu'un reset armé** : les deux timers expirent au même
  instant (`_idleSince + idleMs`) ; D2 étape 0 cède la frontière au reset ;
  `hasPendingContextReset` couvre aussi la fenêtre de frappe de 250 ms.
- **Message arrivé entre la décision et le tir** : le reset est armé ; si
  `sendMessage` réveille l'agent, le reset attend la frontière suivante ; la
  compaction peut alors avoir lieu avec du courrier arrivé entre-temps → le
  stamp remis à `null` re-signale à la frontière d'après (G tient).
- **Lead comme worker** : même règle, même seuil de rôle.
- **Session `paused`** : jamais idle ; `resume()` ré-arme le timer.
- **Redémarrage serveur / auto-resume** : socle, stamps et drapeaux vivent en
  mémoire et repartent de zéro ; les préambules sont réécrits au spawn. Un CLI
  repris déjà à 60 % a pour premier échantillon 60 % → socle 60 → `not-grown`
  jusqu'à 70 % : en retard d'un cran, jamais à tort (assumé).
- **Notice opérateur qui ne tire jamais** (`cancelled`, `never_idle`) :
  `_resolveNotice` ré-arme la frontière, sinon le courrier en attente
  derrière une notice cédée ne serait plus jamais signalé.
- **Rôle supprimé** : `roleStore.get` → `null` → seuil instance.
- **Dialogue jamais résolu** : la session reste `blocked` (loggé une fois) ;
  aucune injection tant qu'un humain n'a pas tapé.

## 4. Lots

### Lot 1a — Serveur : rôle + config (petit, en premier)
`config.ts`, `db/index.ts` (+ fixtures `provider-migration.test.ts`),
`roles/index.ts`, `http/routes/roles.ts`. Tests :
`http/routes/roles.autocompact.route.test.ts` (pattern
`roles.budget.route.test.ts` : null / 0 / 100 / 101 / 3.5 / "35" en POST et
PATCH ; `GET /roles` porte `defaults.autoCompactPct`), round-trip store +
assainissement `rowToRole`, migration idempotente.

### Lot 1b — Serveur : frontière d'inactivité, dialogue, décision, câblage
`session.ts`, `mailbox.ts`, `context-usage.ts`, `auto-compact.ts` (nouveau),
`orchestrator/index.ts`, `messaging.ts`, `spawner/index.ts`,
`skills/activation.ts`, `mailbox-persistence.ts`, `http/routes/hooks.ts`,
`events.ts`, préambules ×2. Tests vitest (`FakeAgentProcess` +
`FakeProvider` + `idleThresholdMs: 50`, pattern `context-reset.test.ts` ;
**piège** : `FakeAgentProcess.write` n'écho rien (`agent-process.ts:433-436`,
il empile dans `writes`) — chaque scénario « frontière après l'écho » doit
émettre de la sortie à la main après l'écriture, sinon le test passe parce
que rien n'a été écrit) :
- `orchestrator/auto-compact.test.ts` — chaque raison + tir, arrondi de `pct`,
  `not-grown` en tokens ;
- `orchestrator/idle-boundary.test.ts` — `onIdle` une fois par période, re-tir
  après nouvelle sortie, pas avant `idleMs`, jamais `paused`, ré-armé par
  `resume()`, libéré à l'exit ; `signalInbox` refuse/stampe ; `_signalFiring`
  fait reculer un reset ; `dialogPending` retient reset et signal, levé par
  `writeInput` qui ré-arme ;
- `orchestrator/context-usage.test.ts` — `floorTokens` = min, remis à `null`
  par `markStale` et `retarget` ;
- `orchestrator/mailbox.test.ts` — `newestTs` ;
- `orchestrator/auto-compact.orchestrator.test.ts` — re-signal après
  `/compact` tiré **une fois le PTY muet**, pas avant ; pas de compact avec
  inbox non vide ; tir à ≥ seuil avec inbox vide ; seuil de rôle prioritaire
  sur l'instance, changement à chaud ; `0` désactive ; `not-grown` après un
  compact au socle ≥ seuil (chiffre pré-compaction ressert) ; message arrivé
  mid-turn signalé à la frontière ; un seul rappel par message ; même
  frontière qu'un reset armé → pas de signal ;
- `http/routes/hooks.test.ts` — `permission_prompt` lève `dialogPending`,
  `idle_prompt` non, champ absent → repli par mode.

### Lot 2 — Web : champ de rôle
`api/client.ts`, `RolesPage.tsx`, `RoleDialog.tsx`. Tests :
`RoleDialog.test.tsx` (champ envoyé, `null` quand vide, `0` quand désactivé),
section RolesPage (`Hérite (35 %)` avec `defaults`, `Désactivé` à 0).
`tsc` + `vitest` web.

### Lot 3 — Docs + vérification
Ce document (état réel), `docs/monitoring-agents.md` (tableau des knobs :
`SWARM_OS_AUTO_COMPACT_PCT` ; `_BYTES`/`_ON_WAITING` requalifiés
secondaires), `docs/providers.md` (§ sémantiques `:162-166` : la garde
dialogue ; tableau `:95` : auto-compact claude/codex/opencode oui, gemini
non), `README.md:185-186` (coupe-circuit). Vérification du CLI épinglé dans
l'image (`Dockerfile:150`, 2.1.142) : **faite** — le paquet npm n'est qu'un
wrapper, le binaire natif `@anthropic-ai/claude-code-linux-x64@2.1.142` porte
`notification_type` (6 occurrences, matchers `permission_prompt`,
`idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_complete`,
`elicitation_response`). Le repli « champ absent » ne devrait jamais être
pris avec les versions déployées.

Ordre : 1a → (1b ∥ 2) → 3. 1b dépend du type `Role.autoCompactPct` de 1a ;
2 ne dépend que du contrat §3.3.

## 5. Vérification

- Serveur : `pnpm -C packages/server test` (une seule suite à la fois —
  ports fixes ; lire `Tests X passed`, pas le code de sortie), référence
  saine avant ce chantier : `tsc` serveur et web à 0 erreur. Web : `tsc` +
  `vitest`. **Résultat à la livraison** : suite serveur complète 2762 tests,
  2761 passés, 1 échec = timeout de teardown (10 s) de
  `test/integration/mcp-swarm-tools.test.ts` (ports fixes ; passe 9/9 deux
  fois en isolation, et la première exécution complète avait donné
  2732/2732) ; erreur non gérée = le `ENOENT` de teardown pré-existant de
  `persistence.test.ts`. `tsc` serveur et web : 0 erreur. Web : 58 fichiers,
  1092 tests passés. Nouveaux tests : ~150 (décision, frontière, garde
  dialogue, orchestrateur, hooks, rôle/route/config, spawner, web).
- Docker : `docker build -t swarm-os:latest . && docker compose -f
  docker-compose.test.yml up -d`, puis sur une team claude :
  1. rôle sans valeur → jauge CTX qui monte ; à la première frontière ≥ 35 %
     avec inbox vide : ligne `auto-compact armed` dans la console de session,
     badge pending, `/compact …` visible, CTX retombe au tour suivant ;
  2. envoyer un message au worker **pendant** sa compaction → à la fin, le
     signal d'inbox apparaît et le worker appelle `team.read_inbox` ;
  3. rôle à `0` → jamais de tir ; rôle à `20` → tir plus tôt, sans
     redémarrage ;
  4. team gemini → jamais de tir, CTX `—` ;
  5. session claude en mode `default` : provoquer un dialogue de permission →
     envoyer un message → rien n'est tapé ; répondre depuis la console → le
     signal arrive à la frontière suivante ;
  6. `SWARM_OS_AUTO_COMPACT_PCT=0` → jamais de tir (`disabled`).

## 6. Hors périmètre (explicite)

- Réglage instance en base + SETTINGS UI (env seulement).
- Toast web à chaque auto-compact.
- `invalidate()` du source claude (jauge honnête post-compaction).
- Re-nudge périodique d'un agent qui n'a jamais lu son inbox (un `warn`
  throttlé le signale).

## 7. Trace de validation (2026-09-14)

Trois relecteurs read-only ont challengé la v1 de ce plan ; corrections
intégrées ci-dessus :
- **BLOCKER** (×3 concordants) : le source claude ne s'invalide pas après
  `/compact` → socle = **minimum** depuis le reset (D3), plus de cooldown.
- **MAJOR** : `pct` est une fraction 0..1 (D3) ; six sites d'injection du
  signal, pas un — `signalInbox()` (§3.2) ; course signal ↔ reset sur la même
  frontière → étape 0 de D2 + `_signalFiring` ; garde dialogue à appliquer
  aussi au signal et aux resets, et la garde par store d'approbations était
  inopérante (`idle_prompt` non filtré) → `dialogPending` (D5) ; frontières
  manquées sans octet PTY → sites d'armement (D1) ; `refresh()` inutile et
  handler asynchrone ré-entrant → handler synchrone sur `snapshot()` (D2) ;
  fixtures `RoleRow` (§3.3) ; `refresh` vs `enabled`/`ready` (caduc).
- **MINOR** : ancres corrigées ; `RoleBody` ; `RoleView`/`defaults?` ;
  `Mailbox.newestTs` ; hygiène du timer ; `instructions` une ligne ;
  logs « une fois par changement de raison » ; famine C3 → `warn`.
- **Seconde passe (mécanisme)** : `_resolveNotice` ré-arme la frontière ;
  les sites d'armement sans octet remettent `_idleNotified` à `false` ;
  repli `isPromptingMode` (et non `shouldArmApproval`, qui peut lister
  `bypassPermissions`) ; reset parqué sur `paused` ; `markStale()` sur
  `SessionStart(source=compact|clear)` (compact interne de Claude Code) ;
  `dialogPending` posé avant l'événement `waiting`, `warn` sur son âge.
- **Seconde passe (design)** : seuil non entier → `disabled` ; étape 0
  portée par la Session sans consommer la frontière ; `_signalFiring` dans le
  refus de `signalInbox` ; ligne « held — dialog pending » + raison
  `deadline-dialog-pending` ; repli non typé loggé ; hystérésis 10 points en
  absolu confirmée (pas de clamp) ; piège `FakeAgentProcess` sans écho.
- **Relecture du code livré** (read-only, contre ce contrat) : aucun bloquant.
  Un MAJOR corrigé — les sites d'armement « humains » (`clearDialogPending`,
  `resume()`) tiraient 1 ms plus tard sur un `_idleSince` périmé (un
  dialogue resté des minutes à l'écran), donc le signal d'inbox ou un
  `/compact` retenu pouvait soumettre une réponse à moitié tapée : ces deux
  sites re-basent `_idleSince = Date.now()` pour exiger une vraie fenêtre de
  silence après la frappe / le `SIGCONT`. Mineurs corrigés : garde statut
  terminal dans `_scheduleIdleCheck` ; `_stopRequested` respecté par la
  frontière et `requestContextReset` ; pas de `maybeRefreshContextUsage()` à
  la frontière quand la décision est `disabled` (un fleet à `0` garde la
  cadence de lecture d'avant) ; les réponses automatiques d'xterm.js
  (DA/CPR/DECRPM/OSC, focus) ne comptent pas comme une frappe humaine ; deux
  tests rendus discriminants (spinner émis à la main pendant la
  « compaction ») ; tests ajoutés (`starved`, `skipped` par changement de
  raison, branche sans reset, trois types bloquants, résolution de rôle via
  le Spawner).
