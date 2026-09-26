# Monitoring des agents — contexte, messages, inbox + compact/clear opérateur

## Pourquoi

swarm-os orchestre des équipes d'agents CLI (claude/codex/gemini/opencode) en PTY interactif, 24/7 en Docker. Aujourd'hui :

- **Aucune télémétrie de contexte/tokens** n'existe (seul proxy : `_bytesSinceReset`, privé, gaté par `SWARM_OS_AUTO_COMPACT_BYTES`).
- **Pas de compteur « messages traités » par agent** : `Mailbox.read()` draine et jette ; `readCount` compte les drainages, pas les messages.
- La mécanique compact/clear (`Session.requestContextReset` — jamais mid-turn, mono-occupant, préambule durable par provider) n'est **pilotable que par les agents via MCP** (`team.context_compact` / `team.context_clear` / `team.clear_worker`) : aucune route HTTP, aucun bouton UI.

Objectif :

1. Utilisation de contexte de **chaque agent** visible dans le panneau latéral.
2. **Page dédiée « Monitoring »** accessible par le menu (⌘K) : contexte, messages traités, inbox en attente, statut, activité, uptime + actions par agent.
3. **Compact / clear en un clic** (panneau + page) via la mécanique swarm-os → préambules correctement restitués (canal durable : `--append-system-prompt` claude, `AGENTS.md` codex, instructions opencode ; re-signal de l'inbox post-`/clear` déjà en place dans `Orchestrator._onSessionContextReset`).
4. Providers : **claude obligatoire**, codex + opencode **best-effort** (spikes préalables), **gemini exclu** du context usage (les boutons compact/clear restent actifs — `contextResetLine` existe).

## Architecture

### Usage de contexte claude — hook `SessionStart` (canal principal)

Les CLI tournent en TUI dans un PTY : rien d'exploitable en sortie. La source fiable est le **transcript `.jsonl`** de Claude Code (les lignes assistant portent `message.usage`). **Spike 9/9 CONFIRMED sur le CLI 2.1.251** (`scripts/verify-claude-sessionstart.report.md`) : le hook `SessionStart` fire au startup TUI, en `-p`, après `/clear` (`source=clear`) et après `/compact` (`source=compact`) ; payload stdin exactement 5 clés : `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source`.

- Ajout d'un hook `SessionStart` (matcher vide `''` = toutes sources) au `settings.json` per-session écrit par le provider claude (`providers/claude.ts`, aujourd'hui hook `Notification` seul). Refactor : builder de commande hook **paramétré par `kind`** (`session.waiting` est en dur dans `providers/session-config.ts`). Nouveau kind `session.transcript` → `http/routes/hooks.ts` parse `transcript_path` → `session.setTranscriptPath()`.
- ⚠️ **Le hook doit être muet sur stdout** — CONFIRMÉ par spike : le stdout d'un hook SessionStart est injecté dans le contexte de l'agent (ligne `attachment`/`hook_success` dans le transcript). Forme validée end-to-end (y compris contre un 400) : `curl -sS -m 5 -o /dev/null -X POST … --data-binary @- '…/hooks/<secret>/session.transcript' >/dev/null 2>&1 || true`.
- Le risque H6 tombe pour SessionStart (hook exit≠0 = non bloquant, `hook_non_blocking_error`) ; on livre quand même la branche `hooks.ts` d'abord, par prudence.
- **Asymétrie clear/compact** (spike) : `/clear` **rotationne** (nouveau session_id CLI + nouveau fichier ; l'ancien reste orphelin sur disque) ; `/compact` réécrit **en place**. Le chemin du payload couvre les deux — toujours adopter le dernier chemin reçu.
- Belt-and-braces : tenter `JSON.parse(message).transcript_path` aussi dans la branche Notification existante.
- Fallback dernier recours (affaibli par les orphelins post-clear) : plus récent `.jsonl` du projects dir correspondant au cwd (mtime ≥ startedAt), **refusé si plus d'une session claude vivante partage ce cwd** (le symlink `projects` est partagé).

**Tracker par session** (`modules/orchestrator/context-usage.ts`, nouveau) : `snapshot()` synchrone + `maybeRefresh()` fire-and-forget, TTL `SWARM_OS_CONTEXT_USAGE_TTL_MS` (défaut 15 000 ms, 0 = désactivé). Déclenché depuis `Orchestrator.toView()` : les données voyagent sur le poll `/orchestrators` 3 s existant — **aucun timer global, aucun event WS nouveau**. Garde-fous : timestamp posé au début du refresh + flag in-flight + cap global (~4) de refresh simultanés (chemin SSH). Tracker actif uniquement pour les sessions `running|waiting` ; rien de sérialisé pour les sessions terminées.

Lecture bornée `tail -c 65536` : locale via fs, SSH via `hostExec` (modèle `catalogue.ts#readCodexCache`). Parse en **fonction pure exportée** (réutilisable par le futur module coût de `docs/auto-amelioration.md`), **en remontant le fichier à l'envers** (la dernière ligne n'est presque jamais une ligne assistant : `last-prompt`, `queue-operation`, `attachment`…) : première ligne `type:'assistant'` avec `message.usage` rencontrée en remontant, sauter `isSidechain:true`, ignorer la première ligne partielle du tail ; `used = input + cache_read + cache_creation + output`. ⚠️ **Ne jamais sommer les lignes assistant** : plusieurs lignes consécutives d'un même tour portent le même `message.id` et le même `usage`.

Invalidation : callback `_onContextReset` → `stale:true` ; `SessionStart(clear|compact)` re-fournit le nouveau chemin. ⚠️ Un `/compact` refusé par le CLI (« Not enough messages to compact ») ne déclenche **aucun** hook : le badge `contextResetPending` retombe quand le reset a été tiré (`_fireContextReset`), jamais en attendant un SessionStart.

### Forme du champ (serveur `session.ts`, miroir web `client.ts`)

```ts
export interface ContextUsageView {
  usedTokens: number;
  limitTokens: number | null;   // catalogue limit.context, sinon fallback pinné PAR MODÈLE, sinon null
  pct: number | null;           // min(1, used/limit) — calculé serveur
  basis: 'transcript' | 'control-plane' | 'estimated';
  updatedAt: string;            // ISO
  stale: boolean;               // après /clear tant qu'aucun nouveau tour lu
}
// SessionView, champs additifs : contextUsage?, inboxCount?, messagesProcessed?, contextResetPending?
```

UI : seuils ok < 0.7 ≤ warn < 0.9 ≤ bad ; `—` si null (doctrine `lib/loadPercent.ts` — jamais de chiffre inventé).

### Limites par modèle

`providers/catalogue.ts` : lire `limit.context` de models.dev (`RawModel`/`LiveModel`/`readModel` le jette aujourd'hui). Vérifié live : models.dev porte `limit.context` pour claude. Fallback pinné **par modèle** (pas par provider). Mettre à jour `catalogue.fixture.ts` (aucun champ `limit` aujourd'hui) + test séparé du fallback.

### Messages traités / inbox

- Compteur incrémenté au **point unique de drainage** `Mailbox.read()` (évictions, `removeSession`, `clearAll` ne comptent pas). **Miroité sur la Session** (setter au drainage) — obligatoire : `DbPersistence.writeSession` construit la row depuis `session.toView()`, et `GET /sessions/:id` (poll 2 s du RightPanel) sert `session.toView()` direct. Colonne additive `messages_processed` (migrations `applyMigrations`, `sessionToRow`/`rowToSessionView`), seed au `Orchestrator.resume()` depuis les rows.
- `inboxCount = mailbox.size(sid)` décoré dans `Orchestrator.toView()` (la Session n'a pas accès à la mailbox).
- Simplification incluse : **suppression du poll N+1 `peekInbox`** du SwarmController (3 s × toutes les sessions). Seul consommateur vivant : `mapViewTeams` → badge `Node` ; substitution par `s.inboxCount ?? 0` dans `toMapViewTeams`. `peekInbox` reste pour le contenu (onglet MESSAGES).

### Action compact/clear opérateur

- `POST /sessions/:id/context-reset`, body `{cmd:'compact'|'clear', instructions?}` (cap taille, whitelist) → nouvelle méthode `Orchestrator.requestContextReset(sessionId, cmd, instructions?)` acceptant **lead et workers** (`requestWorkerContextReset` reste lead-only : sémantique voulue du tool MCP `team.clear_worker`).
- `Session.supportsContextReset(cmd)` (délègue à `provider.contextResetLine(cmd) !== null`) pour un 409 franc. Réponses : `200 {scheduled:true}` ; `409 RESET_ALREADY_PENDING` ; `409 PROVIDER_NO_RESET` ; `409 SESSION_NOT_ACTIVE` ; `404`.
- Exécution différée à l'idle (voulu — jamais mid-turn). Feedback UI : toast « programmé — s'exécutera à l'idle » + badge `contextResetPending` qui retombe au poll 3 s.

## Lots

### Lot 0 — Designs (Claude Design) + ce document
4 artboards : (1) page Monitoring desktop (les rangées du tableau illustrent les états `—`, stale, pending, warn/bad) ; (2) RightPanel : cellule **CTX** (remplace LOAD, placeholder mort) + boutons COMPACT/CLEAR + badge pending ; (3) LeftPanel : 2 variantes (sous-rangées par agent / repli top-N + « +N more ») ; (4) mobile (accès sans 7ᵉ bouton dock — dock plein). Labels ALL-CAPS anglais : `MONITORING`, `CTX`, `COMPACT`, `CLEAR`.

### Lot 1 — Serveur : champs de base SessionView
`mailbox.ts` (compteur processed au read + getter), `messaging.ts`/`orchestrator/index.ts` (miroir sur Session au drainage, décoration `inboxCount` dans toView, seed au resume), `session.ts` (champs SessionView + `contextResetPending` + setter), `persistence.ts` + `db/index.ts` (colonne `messages_processed`). Tests vitest : read() incrémente de N ; évictions ne comptent pas ; round-trip row ; seed resume.

### Lot 2 — Serveur : context usage claude + limites modèles
`context-usage.ts` (tracker + parse pur), `session-config.ts` (builder hook paramétré par kind, muet), `claude.ts` (hook SessionStart), `hooks.ts` (kind `session.transcript` → 200 ; parse aussi dans Notification), `session.ts` (setTranscriptPath, invalidation), `catalogue.ts` + fixture (limit.context + fallbacks par modèle), `config.ts` (TTL knob). Ordre interne : branche hooks.ts d'abord (risque H6). Tests : parse tail (sidechain, ligne coupée), TTL + in-flight + cap, fallback multi-session refusé, hooks 200, readModel.

### Lot 3 — Serveur : route context-reset
`orchestrator/index.ts` (méthode opérateur lead+worker), `session.ts` (supportsContextReset), `http/routes/sessions.ts` (route + validation + mapping `SessionActionError`). Tests : lead accepté, double demande → 409, provider sans reset → 409, statuts terminaux refusés, mappings providers intacts (`/clear`→`/new` codex).

### Lot 4 — Web : panneau latéral + actions
`client.ts` (types miroirs + `contextReset()`), `rightPanelAdapters.ts` + `RightPanel.tsx` (CTX remplace LOAD ; `AgentAction` étendu — CLEAR confirmé via ConfirmModal `danger`, COMPACT direct ; désactivés si pending), `LeftPanel.tsx` (variante retenue au design), `SwarmController.tsx` (cases compact/clear + idiome `_exhaustive: never` dans le switch onAction ; **callback `onContextReset(sessionId, cmd)` découplé de la sélection** ; toast d'erreur via `apiErrorMessage`), `AgentSheet.tsx` (miroir mobile), `desktop-theme.css`, `icons.tsx`.

### Lot 5 — Web : page `#/monitoring`
`App.tsx` (Route/parseHash/setHashRoute/montage gaté par `open`), `SwarmController.tsx` (onOpenMonitoring), `DesktopShell.tsx`, `TopBar.tsx` (handlePick exhaustif), `CommandLauncher.tsx` (LauncherActionId + LAUNCHER_GROUPS), accès mobile selon design. `MonitoringPage.tsx` (nouveau, clone structurel d'`ApprovalsPage.tsx` : overlay `.board-overlay`, polling gaté par `open`). Contenu : KPIs (`BusHealthCell` : agents actifs, backlog inbox total, max/moy contexte, msgs/min) + tableau trié pct desc (team / agent / provider / statut / jauge CTX / traités / inbox / last activity / uptime / COMPACT·CLEAR + pending), actions via `onContextReset`. Inclut la suppression du poll N+1 peekInbox.

### Lot 6 — Codex (spike 6/6 CONFIRMED — `scripts/verify-codex-rollout.report.md`)
Le tracker taile `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<thread-uuid>.jsonl` (flush continu, lisible en vol). Formule : `used = last_token_usage.total_tokens` ; `pct = used / model_context_window` — **jamais `total_token_usage`** (cumulatif de facturation, observé à 45× la fenêtre) ; `cached_input_tokens` est un sous-ensemble d'`input_tokens` (ne pas additionner) ; `info` nullable (événements `rate_limits` seuls) à ignorer. Pièges confirmés : le rollout **n'existe pas au boot** (naît à la 1ʳᵉ requête modèle — tolérer l'absence, re-résoudre) ; après `/new` le nouveau fichier est créé **paresseusement** (mtime = faux positif silencieux) → **clé sur le `thread-id` livré par `notify`**, mtime en repli. Le % affiché par `/status` retranche un socle (~12K calé sur 2 mesures) : garder le ratio brut. Non prouvé : la chute d'`input_tokens` après un `/compact` chargé (session de test trop petite). Bonus dispo sur la même ligne : `rate_limits` (quota compte).

### Lot 7 — Opencode (spike 7/7 CONFIRMED — `scripts/verify-opencode-tokens.report.md`)
Le tracker polle le plan de contrôle HTTP per-session déjà lancé/authentifié (`controlPlane()`, basic-auth `swarm:<password>`). Formule : `used = tokens.total` du **dernier message assistant TERMINÉ** (`time.completed` renseigné — pendant un tour le message existe avec des compteurs à zéro : filtre obligatoire) de `GET /session/{id}/message` ; limite via `GET /config/providers` → `models[<id>].limit.context` (jointure par `model.providerID/id`). ⚠️ **Ne jamais lire `GET /session`.tokens** : agrégat de facturation cumulatif, ne redescend pas au `/compact`. ⚠️ `/clear` crée une **nouvelle session paresseusement** (au prompt suivant) → re-résoudre la session à CHAQUE poll par `max(time.created)`. `tokens.total` redescend bien au `/compact` (validé au caractère près contre la barre de statut du TUI). Fraîcheur : compteurs mis à jour en cours de tour — poll 15 s confortable. **Local uniquement** (sous SSH il faudrait un forward `-L`, même gap que le consommateur `/event`, opencode.ts:868-871). Piège prod noté : un port fixe peut échouer à bind (TIME_WAIT) et le TUI continue **silencieusement** sans plan de contrôle — le tracker doit rendre `—`, pas échouer.

### Lot 9 — Historique de contexte (graphique temporel)
Mémoire pure, **3 jours glissants** (décision opérateur : pas de persistance, mais une instance vit plusieurs jours). Le `ContextUsageTracker` accumule chaque échantillon accepté (`{t, used}`, ~4/min → ≤ 17 280 pts/session, éviction > 72 h) + un anneau de resets (`{t, cmd}`, alimenté au tir réel de `_fireContextReset` — jamais par hook). Expositions :
- `SessionView.contextSpark?: number[]` — les ~20 derniers pct (entiers 0-100), uniquement running|waiting avec limite connue → sparklines gratuites sur le poll 3 s ;
- `GET /sessions/:id/context-history?window=1h|24h|3d` → `{limitTokens, points: [{t, min, max, last}], resets: [{t, cmd}]}`, **buckets min/max/last** (≤ ~300) pour que les chutes de compact/clear ne soient jamais lissées ; appelé seulement bandeau ouvert.
Web : colonne SPARK dans le tableau MONITORING (Sparkline existant) ; clic sur une rangée → bandeau graphique sous les KPIs (sélecteur 1H/24H/3D, ligne+aire ambre, seuils 70/90 % pointillés étiquetés, marqueurs COMPACT/CLEAR étiquetés, crosshair+tooltip, refresh 30 s bandeau ouvert). Aucun timer serveur nouveau, rien de sérialisé pour les sessions terminées, historique perdu au restart (assumé, affiché dans le bandeau).

### Lot 10 — Jauges système CPU / mémoire du conteneur
Deux jauges en arc (180°, seuils 70/90 %) en tête de la page MONITORING, montrant l'utilisation CPU et mémoire du **conteneur du déploiement**. Source : les **cgroups du conteneur lui-même** (aucune socket Docker) — couvre tous les processus, CLIs agents inclus :
- mémoire : `memory.current` / `memory.max` (v2 ; fallback v1 `memory.usage_in_bytes`/`limit_in_bytes`) ; limite `max` (illimitée) → base hôte `os.totalmem()`, taguée `HOST BASIS` ;
- CPU : `cpu.stat` (`usage_usec`) en **delta entre deux lectures** (échantillonnage lazy à la requête, jamais de timer : le point précédent est mémorisé, delta ≥ 1 s sinon valeur cachée, premier appel → null) ; cœurs = quota `cpu.max` sinon `os.cpus().length` (base hôte taguée).
Endpoint `GET /metrics/system` → `{cpu: {pct, cores, basis}, memory: {usedBytes, limitBytes, pct, basis}}` (tous nullables — cgroups illisibles → `—`, jamais d'invention). UI : poll 3 s **uniquement page ouverte** (pattern `useBusHealth` + `enabled`), valeur textuelle en tokens texte, l'arc seul porte la couleur de seuil.

### Lot 11 — Tokens in/out + estimation de coût par agent
Quatre compteurs **cumulatifs** par session — `in` (input non-cache), `out`, `cacheRead`, `cacheWrite` — alignés sur le schéma prévu par `docs/auto-amelioration.md` (`learning_episodes`), + `costUsd` estimé via les tarifs du catalogue. Sources exactes par provider (spikes) :
- **claude** : le transcript est append-only → **lecture incrémentale par offset d'octets** (cap ~1 Mo/poll, rattrapage sur plusieurs polls, jamais de saut silencieux), déduplication par `message.id` (deux lignes d'un même tour répètent le même `usage` — compter UNE fois par id, LRU ~64 ids), sidechains INCLUS (dépense réelle). Mapping : `in = input_tokens`, `cacheRead = cache_read_input_tokens`, `cacheWrite = cache_creation_input_tokens`, `out = output_tokens`. Rotation `/clear` : totaux conservés, offset + ids remis à zéro sur le nouveau fichier.
- **codex** : delta du **cumulatif `total_token_usage`** du rollout (c'est le compteur de facturation écarté pour la jauge — exactement le bon ici). `cached_input_tokens` est un sous-ensemble d'`input_tokens` → `in = input − cached`, `cacheRead = cached`, `cacheWrite = 0`, `out = output`. Nouveau thread (`/new`) → base remise à zéro, totaux conservés.
- **opencode** : delta de l'agrégat `tokens` de `GET /session` (somme de facturation exacte) par session opencode ; `/clear` crée une nouvelle session → accumulation à travers les rotations. `in = input`, `out = output + reasoning`, cache.read/write mappés.
- **gemini** : rien (`—`).
Persistance : colonnes additives nullables `tokens_in/out/cache_read/cache_write` sur `sessions` (miroir sur la Session au fil de l'eau, écriture via le throttle 1 s existant, seed au resume — pattern `messages_processed`). Exposition : `SessionView.tokenUsage?: {in, out, cacheRead, cacheWrite, costUsd: number|null, costBasis: 'estimated'}`. Coût : tarifs `cost.input/output/cache_read/cache_write` de models.dev (étendre `readModel` qui garde déjà input/output) ; un bucket sans tarif connu contribue 0 (jamais de tarif inventé) ; `costUsd` null si input ET output inconnus. UI : colonne `TOKENS · COST` (ligne 1 `IN x · OUT y`, ligne 2 `$z EST` mutée, tooltip avec ventilation cache) + cellule KPI `EST. COST` (Σ agents affichés).

## Suivi du coût — lots 12 à 16 (dépendent tous du lot 11)

### Lot 12 — Coût par équipe + burn rate + workers retirés
- **Vérité d'équipe = la DB, pas la mémoire** : les workers killed/removed gardent leur ligne `sessions` (soft-delete `hidden_at`) avec leurs compteurs du lot 11 → agrégat SQL par orchestrateur (`SUM(tokens_*) GROUP BY orchestrator_id`, lignes cachées INCLUSES). Nouvelle méthode `SwarmDb` + endpoint **`GET /metrics/costs`** → `{teams: [{orchId, name, live, total: {in,out,cacheRead,cacheWrite,costUsd}, removed: {count, costUsd}, burnPerHour: number|null}]}` — pollé ~15 s page ouverte uniquement. Détail : **`GET /orchestrators/:id/cost`** → ventilation par session (nom, statut, retiré ou non, 4 compteurs, coût) pour la vue dépliée. Sessions antérieures au lot 11 → compteurs NULL → contribution `—` (jamais 0 inventé).
- **Burn rate** : anneau `{t, costUsdCumulé}` par session dans le tracker (même infra/éviction que le lot 9) ; `burn = (coût(now) − coût(now−1h)) / 1h`, null si < 2 points ; burn d'équipe = Σ sessions vivantes.
- Web : section **TEAM COSTS** sur la page MONITORING (rangées par team : total $, burn $/H, `INCL. N REMOVED · $x`, dépliable → liste des workers retirés avec badge KILLED/REMOVED façon `badge-reason`) + cellule KPI **BURN /H** globale.

### Lot 13 — Cache hit, basis « reported », tri par coût
- **Cache hit** (aucun changement serveur) : `cacheRead / (in + cacheRead)` calculé côté client — dans le tooltip TOKENS·COST et la vue d'équipe. C'est le levier n°1 du coût claude ; croisé avec les marqueurs compact/clear du bandeau (le coût d'un `/clear` = cache re-créé).
- **Reported opencode** : les messages portent un champ `cost` calculé par opencode → accumuler comme les tokens ; quand présent, `costBasis: 'reported'` et le montant rapporté prime sur l'estimation.
- **Quota codex** : `rate_limits` (used_percent, resets_at, plan) arrive sur la ligne `token_count` déjà lue → exposé par session codex (`providerQuota?`), affiché en chip discret (c'est un quota de COMPTE, pas de l'agent — libellé explicite).
- **Tri** : contrôle SORT du sidebar (CTX ▾ / COST ▾) + coût courant dans l'en-tête du bandeau historique.

### Lot 14 — Budgets et garde-fous
- Rôles : colonnes additives `cost_budget_usd REAL` (NULL = pas de budget) + `budget_action TEXT` (`notify` | `pause`) — pattern exact `auto_remove_dead_workers` (migration, validation routes roles, RoleDialog).
- **Janitor budget** (pattern reaper : module pur + `start*` unref'd + intervalle config `SWARM_OS_BUDGET_CHECK_INTERVAL_MS`, défaut 60 s, 0 = off) : par team d'un rôle à budget, coût cumulé (agrégat DB du lot 12, workers retirés inclus) vs budget → dépassement : event `session.budget_exceeded` (bus → WS existant), notification Discord si webhook, et si `pause` : `pauseSession` de TOUTE la team (lead compris). **One-shot par franchissement** (état en mémoire ; ré-armé si le budget remonte).
- Web : champs budget dans RoleDialog (ne pas casser les champs reaper non commités déjà présents), toast actionnable au dépassement (pattern waiting-toasts), badge `OVER BUDGET` (bad) sur les rangées concernées.

### Lot 15 — Tendances longues, export, tarifs pinnés
- Table additive **`session_token_daily`** (`day, session_id, orchestrator_id, in, out, cache_read, cache_write, cost_usd`, PK (day, session_id)) écrite par un janitor horaire (upsert du jour depuis les cumulatifs ; GC > 90 jours au boot, pattern mailboxJanitor). Base des courbes multi-semaines SANS RAM — l'UI de tendance longue viendra plus tard, la table d'abord.
- **`GET /metrics/costs/export?format=csv|json&days=N`** (défaut 30, cap 90) → lignes quotidiennes par session/team, bouton EXPORT dans le sidebar de la page.
- **Tarifs pinnés de secours** : `PINNED_COST_RATES` par famille de modèle (mêmes précédents que `PINNED_CONTEXT_LIMITS`, uniquement des tarifs sourcés) — sans ça, models.dev injoignable = les `$` disparaissent.

### Lot 16 — Coût par carte taskboard (pont vers auto-amélioration)
- v1 volontairement minimale : au passage d'une carte en `doing`, snapshot du `costUsd` cumulé de la session assignée ; au passage en `done`/`blocked`, delta → colonne additive `cost_usd` sur la table des cartes. Attribution honnête : NULL si l'assigné a changé en route ou si la session n'a pas de compteurs. Web : `$x` muté sur les cartes done du board. C'est l'amorce de `learning_episodes` (`docs/auto-amelioration.md`) — $/tâche, ROI par rôle/modèle.

Ordre d'exécution : 11 → 12 → 13 → 14 → 15 → 16, chaque vague = 1 teammate serveur + 1 web en parallèle (surfaces disjointes entre paquets, jamais deux serveurs en même temps).

### Lot 8 — Docs finales (ce document, mis à jour à la livraison)
`docs/providers.md` (colonne context usage du tableau comparatif), ce document mis à jour (état réel), knobs config documentés.

Ordre : 0 → 1 → 2 → 3 → 4 → 5 → (6 ∥ 7) → 8. Chaque lot livrable seul (champs optionnels de bout en bout).

## État d'implémentation (2026-08-30)

**Lots 0 à 16 livrés** (designs : canvas Claude Design « Agent Monitoring », 10 artboards ; serveur : 1-3, 6-7, 9-16 ; web : 4-5, 9-16). Écarts notables des lots coût (11-16), tous délibérés :

- **Lot 11** : alias claude nus (`sonnet`, `opus`…) → jauge OK mais coût `null` (résoudre un alias vers un tarif serait un tarif inventé). Re-base du premier relevé codex/opencode sur session reprise (sinon double facturation à chaque redéploiement).
- **Lot 12** : agrégats SQL en GROUP BY `(orch, provider, model)` — une team mixte opus/sonnet/codex est tarifée bucket par bucket. « Removed » = `hidden_at IS NOT NULL` (killed/removed soft-deleted, lignes conservées).
- **Lot 13** : ⚠️ **divergence assumée** — le `$` PAR AGENT bascule en `reported` (opencode) mais les agrégats d'équipe (`/metrics/costs`, `/orchestrators/:id/cost`) restent en **estimé** : mélanger rapporté et estimé dans une même somme est une question de design ouverte.
- **Lot 14** : la valeur comparée au budget est la **borne inférieure** (Σ des coûts connus) — un dépassement ne peut être signalé qu'en retard, jamais à tort. `exceeded` du poll et le one-shot du janitor partagent la même règle exportée.
- **Lot 15** : `$` codex = borne inférieure via les pins gpt (buckets cache null) — changement visible (`—` → montant). Tick de rollup ajouté post-auto-resume (un conteneur redéployé plus souvent que l'heure ne perdrait jamais sa ligne). Compteur qui recule → clamp 0 sans re-baseline (l'erreur est toujours vers le bas).
- **Lot 16** : une carte créée directement en `doing` n'est pas chiffrée (la création n'est pas une transition) ; la sortie de `doing` vers `todo` (reopen) settle le stint ; les sessions terminées restent éligibles (la facture reste vraie après l'exit).

Écarts des lots 0-10 (inchangés) :

- **Hook `session.transcript`** : réutilise l'endpoint, l'auth Bearer et l'enveloppe `payload=$(cat)` existants de `/hooks/notification` (un seul builder `buildHookCommand({kind})`, la commande `session.waiting` restant identique octet pour octet) plutôt qu'une URL à secret dédiée. `-m 5` + curl muet obligatoires (SessionStart est synchrone au boot et son stdout serait injecté dans le contexte de l'agent).
- **Tracker généralisé** : un `ContextUsageTracker` par session avec une stratégie `ContextUsageSource` par provider (`transcript` claude, rollout codex, `control-plane` opencode, aucun pour gemini) ; TTL/`in-flight`/cap global 4/gardes de génération partagés. Gardes de reset additionnelles : un read en vol résolu sur le fichier/timestamp pré-reset répond `empty` au lieu de re-bénir l'ancien chiffre.
- **`messages_processed`** : compteur mailbox miroité sur la `Session` au point unique de drainage (`readInbox`), colonne SQLite **nullable** (NULL = « jamais mesuré », distinct de 0), seed au resume.
- **Web** : variante B du panneau gauche (section AGENT CONTEXT top-N + lien MONITORING ; rangées teams inchangées). `INBOX` rend `—` (pas `0`) quand le serveur n'expose pas encore le champ. Canal de notices opérateur minimal ajouté (un compact/clear différé serait invisible sinon). `apiErrorMessage` corrigé pour les deux dialectes d'erreur serveur. `lib/loadPercent.ts` supprimé (la cellule LOAD morte est devenue CTX).
- **Accès mobile** : lien MONITORING dans la sheet STATS (dock plein, pas de 7ᵉ bouton).

### Knobs de configuration

| Env | Défaut | Effet |
|---|---|---|
| `SWARM_OS_CONTEXT_USAGE_TTL_MS` | `15000` | Fraîcheur du tracker de contexte (0 = trackers désactivés, l'UI rend `—`). |
| `SWARM_OS_HOOK_URL` | `http://127.0.0.1:<port>` | Base des POST des hooks agents (`<base>/hooks/notification`). **Obligatoire sous `SWARM_OS_AGENT_TRANSPORT=ssh`** : le curl du hook tourne sur l'hôte, où `127.0.0.1:8787` est un autre processus (chez nous, le conteneur *test* — les hooks y mouraient en `hooks.auth_fail token-mismatch`, cassant silencieusement *waiting* ET context usage). Pointer sur le port hôte mappé du déploiement (stiix `:8789`, storyforge `:8093`, trader `:8091`). |
| `SWARM_OS_MAX_INBOX_SIZE` | `100` | (existant) cap d'inbox — les évictions ne comptent jamais comme « traités ». |
| `SWARM_OS_AUTO_COMPACT_PCT` | `35` | Auto-compact à seuil de contexte (`docs/auto-compact.md`) : `/compact` armé à la frontière d'inactivité d'un agent dont le contexte dépasse ce pourcentage de sa fenêtre, inbox vide, jamais mid-turn ; `null` sur le rôle = cette valeur, `0` = coupe-circuit flotte (le rôle peut surcharger via `autoCompactPct`). Providers : claude/codex/opencode ; gemini n'a pas de mesure → jamais de tir. |
| `SWARM_OS_WORKER_AUTO_COMPACT_PCT` | `0` | (v0.10.1) Même seuil, pour les **workers** : `0` = jamais d'auto-compact de worker (défaut — tâches courtes, remis à zéro par leur lead) ; `null` sur le rôle = cette valeur, le rôle peut surcharger via `workerAutoCompactPct`. `SWARM_OS_AUTO_COMPACT_PCT` / `autoCompactPct` ne concernent plus que la lead (`docs/auto-compact.md` §8.2). |
| `SWARM_OS_CONTINUE_AFTER_COMPACT` | `true` | (v0.10.1) Après tout `/compact` tiré par le serveur (auto-compact, `team.context_compact`, opérateur), une ligne `[swarm-os] Contexte compacté. Reprends le travail…` est tapée dans le PTY à la fin de la compaction (une fois, combinée avec le signal d'inbox si du courrier attend). `0`/`false` = off (`docs/auto-compact.md` §8.1). |
| `SWARM_OS_AUTO_COMPACT_BYTES` | `0` | (existant) backstop volumétrique **secondaire** — aveugle au contexte réel ; le seuil en % ci-dessus est le chemin automatique primaire. |
| `SWARM_OS_COST_ROLLUP_INTERVAL_MS` | `3600000` | Cadence du janitor de rollup quotidien (Lot 15) qui alimente `session_token_daily`. `0` = off (l'export ne sert plus que l'historique déjà écrit). Rien n'est perdu à cette cadence : chaque tick classe ce que le précédent n'a pas classé, le repère étant en SQLite. |

## Appels par agent — registre `session_calls` (v0.10.3)

Chaque appel API d'un agent **claude** est enregistré et tracé, sans aucune charge côté agent (ni prompt, ni outil, ni hook) : tout vient du transcript `.jsonl` que le serveur lit déjà.

**Capture.** `scanTranscriptRange` émet un `TranscriptCall` au point exact où un tour est facturé (même dédoublonnage par `message.id`, drain post-`/clear` inclus, sidechains incluses et marquées). Sont ignorés les messages `<synthetic>` (écrits par le CLI, jamais envoyés au modèle) et les usages entièrement nuls. `ts` = horodatage de la ligne du transcript (et non l'heure de lecture) : une lecture tardive range l'appel là où il a eu lieu. codex, opencode et gemini n'émettent rien.

**Table** (`schema.sql`, `CREATE TABLE IF NOT EXISTS` : additive, sans migration de colonnes) : `session_id, orchestrator_id, session_type ('lead'|'worker', dénormalisé pour le split lead/workers sans jointure), ts (epoch ms, INTEGER), message_id, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, context_tokens (= input + cache_creation + cache_read), is_sidechain`. `UNIQUE(session_id, message_id)` + `INSERT OR IGNORE` : une relecture (redémarrage, `/clear`, fichier réécrit) ne crée jamais de doublon. Index `(session_id, ts)`, `(orchestrator_id, ts)`, `(ts)`. Rétention **14 jours**, purgée **à l'insertion au plus une fois par heure** (`CallLedger`, `modules/metrics/call-usage.ts`), sans timer ; les appels déjà hors horizon ne sont pas écrits. Pas de clé étrangère : le registre survit aux lignes qu'il nomme.

**Déclencheurs de lecture — sans navigateur.** Avant v0.10.3, le transcript n'était lu que par `toView()` (poll `/orchestrators` de l'UI) et, pour la lead seulement, à la frontière d'inactivité quand l'auto-compact était actif. Les workers (auto-compact désactivé par défaut) n'étaient donc **jamais lus sans UI**, et aucune lecture n'avait lieu à la sortie : les derniers tours d'un worker terminé ou tué étaient perdus (appels ET compteurs `tokens_*`). Désormais :
- **frontière d'inactivité** (`Orchestrator._onSessionIdle` → `Session.catchUpContextUsage` → `ContextUsageTracker.catchUp`) : lecture incrémentale (les octets depuis le curseur) à chaque fin de tour, **quel que soit l'auto-compact**, TTL ignoré (au plus une par période de silence), garde en vol et plafond global conservés, jusqu'à 4 lectures de 1 Mo si le curseur est en retard ;
- **sortie de l'agent** (`Session._handleExit` → `flush`) : attend la lecture en vol, puis lit jusqu'au rattrapage complet (16 lectures de 1 Mo max), statut ignoré.
Ce sont des événements, pas un calendrier : la doctrine « pas de timer » tient. Limite restante : un arrêt brutal du serveur ne relit pas ce qui n'a pas été atteint. La relecture au redémarrage ne rattrape que si le CLI reprend le même fichier.

**API.**
- `GET /sessions/:id/calls?window=1h|24h|3d|14d` (défaut 24h) → `{window, since, until, aggregated, bucketMs, calls: [{t, n, model, input, cacheWrite, cacheRead, output, context, sidechain?}], hourly: [{t, calls}], totals}`. Au-delà de 600 appels, agrégation SQL en tranches rondes (10 s … 1 h) : sommes + `n`, `context` = **max** de la tranche. Répond aussi pour un agent retiré (connu de la DB) ; 404 seulement si l'id n'est connu nulle part.
- `GET /orchestrators/:id/call-usage?window=…&bucket=5m|hour|day` (défaut `hour`) et `GET /metrics/call-usage` (toutes équipes, plus `teams: [{orchestratorId, name, calls, …}]`) → séries **denses** `lead` / `workers` `[{t, calls, input, cacheWrite, cacheRead, output}]` + totaux, agrégées en SQL (`GROUP BY ts / bucket, session_type`). Plus de 1000 tranches → 400 `TOO_MANY_BUCKETS`.

**UI.** Bande agent : section **API CALLS** sous la courbe de contexte (une barre par appel, tokens empilés NEW IN / CACHE WRITE / CACHE READ / OUTPUT, ligne CONTEXT SENT coupée sur les pauses, infobulle par appel, CALLS / H sur le même axe temps, totaux, fenêtre 1H/24H/3D/14D ; en mode agrégé la barre est l'appel moyen de la tranche). Page MONITORING : panneau **CALL USAGE** (appels ou tokens par tranche, lead et workers empilés, sélecteur d'équipe ou ALL TEAMS, puces par équipe), poll de 60 s page ouverte seulement.

**Coût mesuré** (140 000 lignes = 14 nuits × 10 000 appels, 7 équipes) : agent 24h ≈ 3 ms, équipe 14j ≈ 14 ms, flotte 24h ≈ 12 ms, flotte 14j ≈ 160 ms (série + totaux par équipe), purge horaire ≈ 25 ms, insertion ≈ 4 ms par lot de 500.

## Fraîcheur de la jauge et compact (v0.10.3)

**Symptôme** : « contexte souvent inchangé après un compact ». **Cause mesurée** sur de vrais transcripts (CLI 2.1.2xx) : une compaction ne réécrit **pas** le fichier. Elle **ajoute** au même transcript une ligne `{type:"system", subtype:"compact_boundary", compactMetadata:{preTokens, postTokens}}` puis le résumé ; aucune ligne assistant ne suit avant le prochain appel. Le curseur incrémental resservait donc le dernier tour d'avant compact, et le tracker l'acceptait comme échantillon **frais** (`stale:false`). Après un `/compact` tiré par le serveur, c'était même la lecture suivante, avant que la compaction (~30–80 s) soit finie. Même chose pour la lecture de queue. Le chemin du fichier ne change pas au compact, `retarget` n'y pouvait rien.

**Correctif** : la jauge n'affiche **jamais** l'ancien contexte après un reset.
- `scanTranscriptRange` / la lecture de queue reconnaissent le `compact_boundary` du fil principal : s'il est postérieur au dernier tour, la source répond `empty` + `reset:'compact'` (couvre l'auto-compact interne du CLI et un `/compact` tapé à la main, sans dépendre d'aucun hook).
- `markStale(kind)` (reset tiré par le serveur, `SessionStart` compact/clear) invalide la jauge côté source : toute ligne assistant horodatée **avant** l'invalidation est refusée ; seul un tour écrit après peut redonner un chiffre (couvre aussi un `/compact` refusé par le CLI).
- `ContextUsageView` gagne `awaitingCall?: 'compact'|'clear'` ; pendant cet état `usedTokens` et `pct` valent `null`. L'UI affiche `COMPACTED · NEXT CALL` / `CLEARED · NEXT CALL` à la place du chiffre (tableau, bande, panneau droit, fiche mobile, panneau gauche). L'auto-compact répond `stale`. Le premier tour après le reset rétablit la vraie valeur.
- **Pourquoi pas `postTokens`** : c'est la taille du résumé seul (~5–11 K mesurés), alors que le premier appel suivant envoie ~80–110 K (prompt système, outils, préambule, fichiers rattachés). L'afficher serait un chiffre faux ; `preTokens`, lui, égale bien l'ancienne jauge.

**Chaîne de fraîcheur (mesurée dans le code)** :
| Étape | Valeur |
|---|---|
| Poll UI `/orchestrators` | 3 s (page ouverte) ; la réponse porte le snapshot **d'avant** la lecture qu'elle déclenche → +≤ 3 s d'affichage |
| TTL de lecture (`SWARM_OS_CONTEXT_USAGE_TTL_MS`) | 15 s, horodaté au début de la lecture |
| Plafond global de lectures simultanées | 4 ; au-delà la session est reportée au poll suivant (+3 s) — 20 sessions dues au même instant : jusqu'à +12 s au premier cycle, puis étalées |
| Frontière d'inactivité (fin de tour) | lecture immédiate (TTL ignoré) 2 s après la fin du tour (`SWARM_OS_IDLE_THRESHOLD_MS`) |
| `contextSpark` | un point par lecture acceptée (≤ 1 / TTL / session), sur le même poll |
| Bande historique / API CALLS / CALL USAGE | 30 s / 30 s / 60 s, page ouverte |

Délai max appel → affichage : **≤ ~5 s en fin de tour** (2 s d'inactivité + lecture + ≤ 3 s de poll) ; **≤ ~18 s en milieu de tour** (TTL + poll), ~30 s au pire au premier cycle d'une flotte de 20 sessions synchronisées. Après un reset : l'état `… · NEXT CALL` s'affiche au poll suivant (≤ 3 s, `markStale` est synchrone), la vraie valeur ≤ ~5 s après la fin du premier tour post-reset (le nudge `SWARM_OS_CONTINUE_AFTER_COMPACT` en déclenche un). TTL laissé à 15 s : le cas signalé venait du compact, pas du TTL, et le baisser multiplierait les lectures SSH pendant qu'une page est ouverte.

**Coût SSH** (`SWARM_OS_AGENT_TRANSPORT=ssh`) : les lectures passent par `hostExec` sur le mux ControlMaster (`ControlPersist=600`), pas par le montage. Une lecture = 1 client `ssh` local sur le mux + `sh`/`wc`/`tail`/`head` côté hôte (~4 ms mesurés côté hôte sur un transcript de 1,1 Mo ; client ssh multiplexé estimé ~10–30 ms). Au pic (~600 tours/h sur ~20 sessions) : ~600 lectures/h de plus, soit une toutes les 6 s. À comparer aux ~4 800 lectures/h qu'engendre déjà une page ouverte (20 sessions × 1 / 15 s). Le plafond global (4) s'applique aussi au `flush` de sortie, qui **attend** une place au lieu de la contourner : un kill massif n'ouvre jamais plus de 4 canaux simultanés sur le mux.

## Cas limites

- SSH : tail via hostExec (jamais de throw) ; échec → snapshot précédent + `stale`. Les hooks postent depuis l'HÔTE → `SWARM_OS_HOOK_URL` requis (voir knobs), sinon aucun `transcript_path` n'arrive jamais et les CTX restent `—`.
- Restart serveur / redeploy Docker : relance à froid de tous les CLIs → `prepareSessionConfig` (constructeur de Session) réécrit les settings avec le hook → aucune session « sans hook » ne survit à un déploiement ; fenêtre `—` couverte.
- `/clear` : stale, puis retombe au premier tour suivant ; préambule restitué par le canal durable, inbox re-signalée.
- Gemini : pas de tracker → `—` ; boutons compact/clear actifs.
- Transcript introuvable/illisible : null + warn throttlé, retry au TTL suivant.
- Plusieurs sessions claude même cwd : seul le hook fait foi (fallback mtime refusé).
- Sessions terminées : rien de sérialisé ; la page filtre par défaut sur les actifs.

## Vérification

- Tests vitest serveur (mailbox, tracker/parse, route, catalogue) + tsc/build web.
- Docker : `docker build -t swarm-os:latest . && docker compose -f docker-compose.test.yml up -d` puis contrôle réel : jauges CTX sur une team claude ; page MONITORING via ⌘K ; COMPACT sur un worker occupé (différé à l'idle, badge pending) ; CLEAR sur un worker ET un lead puis vérifier que l'agent répond toujours selon son rôle (préambule durable) et que l'inbox est re-signalée ; `—` pour gemini ; suppression du N+1 sans régression du badge INBOX sur la carte.
