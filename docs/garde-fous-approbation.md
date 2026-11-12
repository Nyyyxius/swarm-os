# Garde-fous d'approbation humaine (« human-in-the-loop ») — proposition

> Rédigé le 2026-08-01 à partir d'une cartographie du code (branche `master`,
> post-taskboard). Même format que `docs/memoire-partagee.md` et
> `docs/tableau-de-taches.md`. Références `fichier:ligne` vérifiées par lecture
> du code, pas de mémoire.

---

## 1. Objectif & contrainte

**Objectif.** Quand une équipe tourne sous un niveau de permission **autre que
`bypassPermissions`** et qu'un agent se bloque sur une **demande de permission**
du CLI, swarm-os doit offrir à l'opérateur une **notification actionnable** :
- **approuver / refuser** directement (web + messagerie), ou
- **ouvrir la console** de la session en un tap, ou
- **confirmer par messagerie** (répondre sur Discord).

C'est le 3ᵉ pilier après **savoir** (mémoire partagée) et **état** (tableau de
tâches) : le **contrôle** — de l'autonomie *supervisée* plutôt que le tout-ou-rien
actuel.

**Contrainte dure (exigée par l'utilisateur).** `bypassPermissions` doit rester
**indépendant** : une équipe créée en bypass ne doit **jamais** être ralentie par
une approbation. Bonne nouvelle — c'est **gratuit par construction** (voir §2.5) :
une session bypass n'émet **aucun** prompt de permission, donc elle n'entre
jamais dans ce flux. Le garde-fou ne s'active que pour les modes *qui
questionnent* (`default`, `plan`).

---

## 2. État actuel du code (as-built)

La plomberie de bas niveau existe déjà à ~80 %. Ce qui manque est surtout de la
**classification + de l'UX**, pas un socle.

### 2.1 Détection du `waiting` — 100 % pilotée par un hook, indifférenciée, éphémère
- Ce n'est **ni un scan de sortie PTY ni un timer d'inactivité**. C'est un
  callback HTTP : le CLI claude reçoit, via son `settings.json`, un hook
  `Notification` qui `POST /hooks/notification`.
  - `packages/server/src/modules/providers/claude.ts:184-188` — capability
    `notificationHook: 'needs-human'` + commentaire : *« fires when the agent is
    BLOCKED on a human (a permission prompt, a question, an idle-too-long
    nudge) »*. **Les trois causes sont fusionnées en une seule valeur.**
  - Commande du hook : `packages/server/src/modules/providers/session-config.ts:139-153`
    — `kind` est **codé en dur à `session.waiting`** au niveau shell ; `message`
    = stdin brut opaque du CLI.
- Point de bascule : `packages/server/src/http/routes/hooks.ts`.
  - `hooks.ts:162-168` — parse `kind`/`message` puis **rejette (400) tout
    `kind !== 'session.waiting'`**. En-tête de module : *« future kinds can map
    here »*. **C'est LE point d'entrée à enrichir.**
  - `hooks.ts:238-243` — émet `session.status_changed` avec
    `payload:{ status:'waiting', reason:'notification-hook' }`.
- **`waiting` n'est PAS un vrai statut de session** : `Session._setStatus` n'est
  jamais appelé avec `'waiting'` ; c'est un **pseudo-statut éphémère, web-only,
  non persisté** (l'event contourne `_setStatus`). Le `session.status` réel reste
  `running`. ⇒ pour un garde-fou robuste, la file d'approbations doit être **sa
  propre structure persistée**, pas un dérivé de ce pseudo-statut.
- **Aucune distinction permission / question / nudge** : le texte qui
  désambiguïse (« needs your permission to use Bash ») est dans `body.message`
  mais **jamais inspecté** (seule sa longueur est loggée, `hooks.ts:205`).

### 2.2 Notification Discord — embed webhook, fire-and-forget, **sans boutons**
- Chemin : `hooks.ts:264-292` → `notifier.notify({ kind:'session.waiting', … })`.
- `packages/server/src/modules/notify/index.ts:57-73` — `NotificationInput`
  possède déjà un sac libre **`extra?: Record<string,unknown>`** (idéal pour
  transporter les données structurées d'approbation).
- `packages/server/src/modules/notify/discord.ts:120-173` — `buildPayload`
  n'émet qu'un **embed webhook** `{ embeds:[{ title, description, color,
  fields[], url? }] }`. **Un webhook ne peut PAS porter de boutons interactifs** :
  ça exige le **bot** (`DiscordBotPool`, `connector-registry.ts:164-217`), objet
  différent.
- Nuance : le ping `waiting` utilise le notifier **global**
  (`http/main.ts:212`, `spawner.notifier`), pas le webhook **par rôle**. Le
  résolveur par-orch `notifierFor(role)` existe (`spawner/index.ts:399-408`) et
  l'objet `orch` est déjà en portée dans `hooks.ts:176` → facile de router vers le
  canal Discord de l'équipe.

### 2.3 Réponse à distance (PTY) — **déjà fonctionnel**
- `packages/server/src/http/routes/sessions.ts:43-64` —
  `POST /sessions/:id/input { data, submit? }`. `submit:true` → tape une ligne +
  Entrée (`submitInput`) ; sinon octets bruts (`writeInput`). C'est ce qu'utilise
  la console xterm.
- Helpers : `orchestrator/session.ts:598` `writeInput` (octets bruts),
  `:620` `submitInput` (ligne + CR, « Ink submit dance »).
- Transport-agnostique : `orchestrator/agent-process.ts:25` `AgentProcess.write`
  (ssh `:254` / local `:346`). Répondre à un prompt = envoyer p.ex. `{data:"1\r"}`
  (choix 1 + Entrée) ou une flèche + CR.
- ⚠️ **Auth** : la seule protection est le **token global** `X-Auth-Token`
  (`http/main.ts:302-303`). Aucune autorisation par session/opérateur.

### 2.4 Routage Discord entrant — corrélation possible mais non câblée
- `packages/server/src/modules/discord/bot.ts:390-462` — `handleMessageCreate` :
  match canal→orch via la map `subscriptions`, puis **push générique** dans
  l'inbox du lead (`bot.ts:424`, → `pushToLeadInbox`,
  `orchestrator/messaging.ts:494-548`).
- **`msg.reference?.messageId`** (la cible d'un *reply* Discord natif) est
  disponible à `bot.ts:424` mais **seulement utilisé cosmétiquement**
  (`bot.ts:472`) — **pas** transmis structurellement. C'est la clé naturelle
  pour « l'opérateur a répondu au message d'approbation qu'on a posté ».
- Le type `Message` de la mailbox (`orchestrator/mailbox.ts:24-62`) porte
  `sourceMessageId`/`threadId`/`threadName` mais **pas de champ *in-reply-to***.
- Seams d'interception : `bot.ts:424` (le plus tôt, a le `msg` complet),
  `plugins/connector-registry.ts:189` (shim Discord intégré),
  `messaging.ts:522` (goulot générique de tout entrant externe).

### 2.5 `permissionMode` — entièrement câblé ; **bypass ne prompte jamais**
- Modes valides (claude) : `['auto','acceptEdits','bypassPermissions','default',
  'dontAsk','plan']` (`claude.ts:175-182`), défaut **`bypassPermissions`**
  (`claude.ts:247-255`), flag `--permission-mode` (`claude.ts:91-92`).
- Défaut instance : `config.ts:572-576`. Par rôle :
  `roles/index.ts:103` `defaultPermissionMode` (persistant). Création d'équipe :
  résolution en couches **body > rôle > config** (`http/routes/orchestrators.ts:211-280`).
  Worker : hérite de l'équipe (`orchestrator/index.ts:774-797`).
- **Confirmé : une session `bypassPermissions` ne produit AUCUN prompt** — le
  `.claude.json` est pré-ensemencé `bypassPermissionsModeAccepted=true`
  (`claude.ts:511-519`). Seuls `default`/`plan` questionnent. ⇒ **la contrainte
  « bypass indépendant » est satisfaite gratuitement.**

### 2.6 Événements & web — extensibles + pipeline de toasts déjà là
- Bus : `packages/server/src/events.ts`. Union **ouverte et additive** :
  précédents `MemorySwarmEventKind` / `TaskboardSwarmEventKind`
  (`events.ts:23-46`) → ajouter `ApprovalSwarmEventKind` est le patron établi,
  non-cassant ; rediffusé tel quel par `/ws/events` (`http/ws/events.ts:10-21`).
- Web : `waiting` a **déjà** le seul traitement visuel « pulsant »
  (`packages/web/src/lib/sessionStatus.ts:47-53`, `StatusBadge.tsx`, drapeau
  TopBar). Surtout, **le pipeline de toasts existe** :
  `hooks/useEvents.ts:334-355` fabrique un `WaitingNotice` depuis
  `session.status_changed status:waiting` → `components/desktop/Toasts.tsx`
  affiche une carte avec `→ OPEN` + dismiss. **C'est là que vivent Approuver /
  Refuser.** `SwarmController.tsx:682` `handleToastOpen` sélectionne la session +
  route vers la console → réutilisable pour « ouvrir la console ».

---

## 3. Le vrai gap (ce qu'il faut construire)

1. **Classifier** le `waiting` comme *demande d'approbation* (vs question/idle),
   et extraire **quoi** est demandé (outil/commande).
2. **Persister** une file d'approbations en attente (corrélation + survie aux
   reconnexions), avec TTL.
3. **Notifier de façon actionnable** (web toast enrichi + Discord + push) :
   Approuver / Refuser / Ouvrir la console.
4. **Router** une réponse Discord vers l'approbation en attente de *cette*
   session (aujourd'hui elle tombe dans l'inbox générique du lead).
5. **Réglages par rôle** : quels modes/outils exigent approbation, TTL,
   comportement au timeout.

---

## 4. Design retenu & décisions

- **CORE, pas plugin** — comme mémoire et taskboard : seul le core peut ajouter
  la classification dans `/hooks/notification`, l'endpoint de résolution, et
  (éventuellement) la directive de préambule. Durable au `/clear`.
- **Deux modèles de gate possibles** (voir §5 pour le second) :
  - **(A) « Surface du prompt natif »** *(retenu pour le MVP, colle au besoin
    exprimé)* : on garde le prompt interactif du CLI ; swarm-os le **remonte**
    comme notification actionnable et **renvoie la frappe** (`writeInput`) ou
    laisse ouvrir la console. Marche pour **tous les providers** (ils bloquent
    tous dans le PTY). Fragilité = mapping frappe↔prompt.
  - **(B) « Hook PreToolUse natif swarm-os »** *(évolution plus robuste, §5)* :
    un hook `PreToolUse` (claude) qui **appelle le serveur et bloque** jusqu'à la
    décision de l'opérateur, puis renvoie `allow`/`deny` structuré. Pas de frappe
    injectée, données structurées (outil + args). Spécifique par provider.
- **File d'approbations persistée** (pas dérivée du pseudo-statut `waiting`
  éphémère), façon `store` mémoire/taskboard (table `CREATE TABLE IF NOT EXISTS`
  sur `swarmDb`).
- **Portée stricte non-bypass** : la classification ne s'arme que si
  `session.permissionMode ∈ {default, plan}` (ou un futur mode dédié). Bypass →
  jamais.
- **Réponse Discord par *reply* natif** (MVP) plutôt que boutons : réutilise le
  routage entrant existant (`msg.reference.messageId`). Les **boutons
  interactifs** (via le bot) sont une amélioration ultérieure.
- **Audit** : chaque décision (qui, quand, approuvé/refusé, canal) est journalisée
  — réutiliser le style *journal append-only* du taskboard.

---

## 5. Variante (B), plus robuste — hook `PreToolUse` (à considérer)

swarm-os injecte déjà un hook `Notification` dans le `settings.json` de chaque
session claude (`claude.ts:374-395`, `session-config.ts:139`). On peut, **de la
même manière**, injecter un hook **`PreToolUse`** (matcher = les outils sensibles,
p.ex. `Bash`, `Write`, `Edit`) dont la commande :
1. POST au serveur le **tool + args** (données structurées : « ce qui est
   demandé »),
2. **bloque** (long-poll borné) jusqu'à la décision de l'opérateur,
3. imprime la décision JSON (`allow`/`deny`) que claude consomme.

Avantages vs (A) : plus de screen-scraping ni de frappes fragiles ; notification
naturellement riche (nom d'outil + arguments) ; politique **par outil**. Le
provider opencode **anticipe déjà** ce découpage (`opencode.ts:261-266`, « LOT 6c :
`permission.asked` = needs-human, distinct de `session.idle` »).

Réserves : **spécifique par provider** ; **à valider** contre le contrat de hooks
claude courant (forme de la décision `PreToolUse`, capacité de blocage/timeout) ;
n'active le gate que si on injecte le hook — donc on ne l'injecte **que** pour les
rôles non-bypass, préservant la contrainte. Recommandation : livrer (A) d'abord
(rapide, multi-provider, colle au besoin), puis évaluer (B) comme évolution claude.

---

## 6. Points d'insertion (fichier:ligne)

**Backend — détection & classification**
- `http/routes/hooks.ts:162-168` — accepter/nouveau `kind` ou classifier
  `body.message` ; **choke point**.
- `hooks.ts:238-243` — élargir `payload` (`reason:'permission'` + objet
  `approval` structuré) sur `session.status_changed`.
- `providers/types.ts:79` `NotificationHookSemantics` + valeur par provider
  (`claude.ts:188`, `gemini.ts:301`, `opencode.ts:266`) si on veut une sémantique
  déclarée `'permission'`.

**Backend — file d'approbations + résolution**
- Nouveau `modules/approvals/store.ts` (patron `modules/memory/store.ts` /
  `modules/taskboard/store.ts`) : table pending (id, orchId, sessionId, requested,
  raw, canal, status, createdAt, ttl, résolution + journal).
- Nouveau `http/routes/approvals.ts` : `GET /api/approvals?orch=`,
  `POST /api/approvals/:id/resolve { decision }` → mappe vers
  `session.submitInput/writeInput` (réutilise `sessions.ts:43-64`) ; émet
  `approval.resolved`. Monté dans `http/main.ts` (patron des autres routers).
- `events.ts` — ajouter `ApprovalSwarmEventKind` (`approval.requested` /
  `approval.resolved`), additif comme mémoire/taskboard.

**Backend — routage réponse Discord**
- `modules/discord/bot.ts:424` — avant `sub.mailbox.push`, si
  `msg.reference?.messageId` (ou `threadId`) correspond à une approbation en
  attente de ce lead → router en décision au lieu du push inbox.
- `orchestrator/mailbox.ts:24-62` — ajouter un champ *in-reply-to*, **ou** garder
  une table `{ postedApprovalMessageId → approvalId }`.
- Poster l'approbation via le **notifier par-orch** (`spawner/index.ts:399-408`)
  et mémoriser l'id du message Discord posté (pour la corrélation).

**Web**
- `hooks/useEvents.ts` (~127-140 option, ~158-169 ref, ~331 dispatch) —
  `onApprovalRequested` + `onApprovalResolved`, patron mémoire/taskboard.
- `components/desktop/Toasts.tsx:58-61` (+ mobile `MobileToasts.tsx:37-40`) —
  boutons **Approuver / Refuser** à côté de `→ OPEN` / dismiss.
- `controller/SwarmController.tsx:682` `handleToastOpen` — réutilisé pour « ouvrir
  la console » ; ajouter `approveApproval/denyApproval` (→ REST) exposés via
  `SwarmControllerValue`.
- (option) `components/ApprovalsPage.tsx` + route `#/approvals` + bouton TopBar —
  patron `BoardPage`/`MemoryPage` (overlay always-mounted gated-by-`open`).
- `components/RolesPage.tsx` (section, patron `CadenceSection`) + `RoleView`
  (`api/client.ts:210-237`) — politique d'approbation par rôle.

---

## 7. Plan phasé

- **P1 — Détection & file (backend, socle).** Classifier le prompt de permission
  au `/hooks/notification` (portée non-bypass) ; `approvals/store.ts` persistant ;
  event `approval.requested`. Tests. *(sans UI ni réponse encore.)*
- **P2 — Canal de résolution (backend).** `POST /api/approvals/:id/resolve` →
  frappe vers le PTY (réutilise `writeInput/submitInput`) ; gestion
  races/timeouts (l'opérateur peut aussi répondre à la main dans la console) ;
  event `approval.resolved` ; journal d'audit. Tests.
- **P3 — Notification actionnable (web + push + Discord texte).** Toast enrichi
  Approuver/Refuser/Ouvrir-console ; embed Discord enrichi (« ce qui est demandé »
  + consigne « réponds ✅/❌ ou ouvre la console ») via le notifier par-orch.
- **P4 — Réponse Discord routée.** Intercepter le *reply* (`bot.ts:424`) /
  thread → décision ; corrélation par `msg.reference.messageId` ou `threadId`.
- **P5 — Réglages par rôle + finitions.** Politique par rôle (modes/outils, TTL,
  timeout=deny par défaut), overlay `#/approvals`, couverture gemini/opencode,
  et (optionnel) variante (B) hook `PreToolUse` pour claude.

*(P1→P2 = le cœur ; P3→P4 = l'expérience ; P5 = confort & robustesse. On peut
livrer/déployer après P3 déjà utile : notif + réponse web.)*

---

## 8. Modèle de données (file d'approbations)

`approval_requests` (SQLite, `CREATE TABLE IF NOT EXISTS`, patron store existant) :
`id` · `orchestrator_id` · `session_id` · `requested_summary` (outil/commande) ·
`raw_message` · `permission_mode` · `channel` (web|discord) ·
`discord_message_id?` (pour corréler un reply) · `status`
(pending|approved|denied|expired|answered_in_console) · `created_at` ·
`expires_at` · `resolved_at?` · `resolved_by?` · `decision?`.
Journal `approval_events` append-only (audit : requested/notified/resolved/expired).

---

## 9. Décisions produit (arrêtées le 2026-08-01)

**Approche** : **(A) d'abord** (surface du prompt natif, tous providers), **puis
(B)** hook `PreToolUse` **pour les modèles Claude** (le provider est sélectionné à
la création d'équipe → B ne s'applique qu'aux sessions claude).

1. **Discord** : **reply-texte** (répondre au message d'approbation), pas de
   boutons. (Les boutons via bot restent une évolution possible.)
2. **Granularité** : **les deux** — « approuver cette action » **et** « approuver
   et ne plus demander » (mappe la 2ᵉ option du prompt claude).
3. **Timeout** : **laisser en attente** (pas d'auto-refus). La demande reste
   ouverte jusqu'à décision ou disparition du prompt (répondu dans la console). Le
   TTL sert seulement au nettoyage/flag, pas à décider.
4. **Qui peut approuver** : **tout le monde** (quiconque a le token global —
   comportement actuel de la route d'input). Pas de restriction par opérateur.
5. **Déclencheur** : **pas de mode dédié inventé.** Les modes de permission sont
   **propres à chaque provider** (remarque de l'utilisateur) → le garde-fou s'arme
   automatiquement dès qu'un **mode qui questionne (non-bypass)** est sélectionné
   pour la session. Prédicat d'armement = `permissionMode !== 'bypassPermissions'`
   **et** le provider produit effectivement un prompt. Une politique **par outil**
   arrive avec la variante (B) pour claude (P5) ; en (A) c'est global à la session.

---

## 10. Risques & mitigations

- **Fragilité frappe↔prompt (variante A)** : le mapping « Approuver → touche »
  dépend de l'UI Ink du CLI (peut changer). *Mitigation* : mapping par provider +
  test de bout en bout ; fallback « ouvrir la console » toujours proposé ;
  envisager la variante B pour claude.
- **`waiting` non persisté** : ne pas s'appuyer dessus → file persistée dédiée.
- **Course opérateur/console** : l'opérateur répond dans la console pendant qu'une
  décision Discord arrive. *Mitigation* : marquer `answered_in_console` si le
  prompt disparaît (le hook `needs-human` ne se ré-arme pas) ; résolution
  idempotente ; TTL.
- **Sécurité** : envoyer une frappe = pouvoir sur le PTY. Garder derrière le token ;
  journaliser chaque décision ; ne jamais auto-approuver.
- **Bypass** : garantir que la classification est court-circuitée si
  `permissionMode==='bypassPermissions'` (test explicite).

---

## 11. Compatibilité providers

- **claude** : `notificationHook:'needs-human'` (`claude.ts:188`) → le signal
  existe ; variante B possible via `PreToolUse`.
- **gemini** : `'turn-complete'` (`gemini.ts:301`) **mais** son `Notification`
  *« fires exclusively on a tool permission request »* (`gemini.ts:299`) — donc en
  mode non-`--yolo` c'est déjà un signal de permission exploitable.
- **codex** : `'turn-complete'` (`codex.ts:146`) — à cartographier (P5).
- **opencode** : `false` (`opencode.ts:266`) — pas encore câblé ; le code
  anticipe `permission.asked` (LOT 6c).

Variante A (surface du prompt + `writeInput`) marche uniformément dès qu'un
provider **bloque dans le PTY** ; la richesse « quoi est demandé » dépend de la
qualité du message remonté (claude/gemini l'ont).
