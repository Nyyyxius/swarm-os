# swarm-os — Synthèse critique des suggestions (Claude / Codex / Gemini)

> Regroupement et challenge des suggestions issues de `plan_suggestion_claude.md`, `plan_suggestion_codex.md`, `plan_suggestion_gemini.md` confrontées à `plan.md`.
>
> Légende décision :
> - ✅ **À appliquer** — pertinent, non redondant, ne complexifie pas trop.
> - 🟡 **À appliquer en version simplifiée** — bon esprit mais à dégonfler pour rester MVP.
> - 🔵 **À documenter comme limite** — vrai problème mais coût > bénéfice en v0.1.
> - ❌ **Rejeté** — hors scope, doublon, ou over-engineering.
>
> Sources notées : `[C]` Claude, `[X]` Codex, `[G]` Gemini.

---

## T1. Communication inter-sessions : PTY-stdin vs mailbox

**Suggestions** :
- `[C-A1]` : remplacer `send_message` PTY par mailbox + outil `team.read_inbox` ; ou n'écrire stdin que si la session est en `idle` (suivi via hooks `PreToolUse`/`PostToolUse`/`Stop`).
- `[X-3]` : approche hybride — mailbox persistée + signal court dans le PTY uniquement si la session est inactive ; ajouter `team.get_messages({ after? })`.
- `[G-1]` : 100% mailbox MCP (`team.get_messages`) ; le préambule force le worker à poll après chaque tâche.

**Challenge** :
- Convergence forte (3/3) — c'est un vrai défaut du plan.
- Le push pur PTY est explicitement risqué (corruption mid-turn, pas d'idempotence, pas d'ack réel).
- Le pull pur mailbox ajoute une latence : un worker ne lit pas son inbox tant qu'il n'est pas appelé. Pour un cas "lead → worker, début de tâche", il faut quand même un signal.
- L'hybride `[X-3]` est le bon compromis : mailbox = source de vérité + signal PTY opportuniste quand la session est `idle` (détecté via `Stop` hook).

**Décision** : ✅ **À appliquer (modèle hybride)**.
- `team.send_message` écrit en mailbox (SQLite, message_id, sender, recipient, ts), retourne `{ message_id, queued: true }`.
- Si destinataire `idle` → injection PTY d'un court signal `[team-comms: nouveau message, appelle team.read_inbox]`.
- `team.read_inbox({ since_message_id? })` retourne les messages.
- Préambule par défaut : "après chaque tool/tâche significative, appelle `team.read_inbox`".
- Retire `am_i_lead` (cf. T19), garde `whoami`, ajoute `read_inbox`.

---

## T2. Stratégie d'injection des hooks Claude Code

**Suggestions** :
- `[C-A2]` : `~/.claude` est RO → impossible d'écrire `settings.json` dedans. Utiliser `CLAUDE_CONFIG_DIR` par session (dir contrôlé par swarm-os) ; le mount RO `~/.claude` reste pour les **credentials** uniquement.
- `[G-2]` : si `claude` ne supporte pas un webhook hook, fallback sur pattern matching dans le PTY ou `CLAUDE_CODE_NOTIFICATION_CMD`.
- `[X-1]` : valider tout ça dans un spike Phase 0 avant de coder.

**Challenge** :
- `[C-A2]` est concret et propose la bonne mécanique (`CLAUDE_CONFIG_DIR`).
- `[G-2]` propose un fallback fragile (pattern matching xterm) qui doit rester un dernier recours.
- `[X-1]` (spike) est de bon sens — on ne peut pas planifier 6 jours sur des hypothèses CLI non vérifiées.

**Décision** : ✅ **À appliquer (combiné)**.
- Phase 0 bis "spike Claude Code" : vérifier hooks, `--mcp-config`, `--permission-mode`, comportement `~/.claude` RO.
- Stratégie hooks : `CLAUDE_CONFIG_DIR=/data/runtime/orch-{id}/session-{id}/.claude` au spawn, avec `settings.json` qui pointe le hook `Notification` vers `http://127.0.0.1:8787/hooks/notification`.
- Pas de pattern matching PTY en MVP.

---

## T3. ~/.claude monté en RO + partagé entre containers

**Suggestions** :
- `[C-A6]` : RO peut casser claude CLI s'il écrit dans son home (projects/, todos/, statsig/).
- `[C-A7]` : plusieurs containers qui mountent le **même** `~/.claude` → conflits d'écriture / corruption.
- `[X-6]` : séparer credentials (RO) du cache/runtime (RW privé).

**Challenge** :
- `[C-A7]` est un vrai bug d'architecture : si on lance deux instances simultanément, les `projects/<hash>/` peuvent se chevaucher.
- `[X-6]` propose la bonne séparation : credentials RO source, cache RW privé par container.
- À valider dans le spike T2.

**Décision** : ✅ **À appliquer**.
- Au boot du container, **copier** les credentials de `~/.claude` (mount RO source) vers un volume privé `/data/.claude-runtime/` (RW), puis exporter `CLAUDE_CONFIG_DIR=/data/.claude-runtime`.
- Documenter en §13 et §14.
- Le mount `~/.claude:ro` reste mais ciblé sur un sous-chemin : seulement le fichier credentials (à confirmer en spike). Sinon, mount complet RO source + copie au boot.

---

## T4. Auth MCP : impersonation entre sessions du même container

**Suggestions** :
- `[C-A3]` : toutes les sessions tournent sous le même uid → `chmod 600` ne protège pas. Une session peut lire le `mcp.json` d'une autre et l'imiter. Suggère : delete-after-load, ou via env, ou accepter la limite.
- `[X-2]` : utiliser un `session_secret` fort distinct du `session_id` (qui apparaît en logs/UI).

**Challenge** :
- Risque réel mais à pondérer : on est single-user, bypassPermissions actif, container isolé. Une session malveillante peut déjà faire BIEN pire que se faire passer pour le lead (ex: `rm -rf /workspace`).
- "Delete-after-load" demande de savoir quand claude a fini de lire le fichier — fragile.
- `[X-2]` (séparer secret du id) est cheap et propre : génère un `session_secret` UUID au spawn, l'utilise dans le path MCP, n'expose jamais le secret en logs/UI.

**Décision** : 🟡 **À appliquer en version simplifiée**.
- Ajouter `session_secret` (UUID v4 généré au spawn, persisté en DB, jamais affiché UI ni log) → path MCP devient `/mcp/:orch_id/:session_secret`.
- Acknowledger en §14 "Limites connues" : un agent qui lit `/proc/<autre_pid>/cmdline` ou `/tmp/swarm-os/...` peut potentiellement extraire le secret d'une autre session du même container. Non corrigé en MVP.
- Pas de delete-after-load (fragile, gain marginal).

---

## T5. Watchdog "session idle trop longtemps"

**Suggestions** :
- `[C-A4]` : ajouter `ActivityMonitor` qui suit `lastActivityAt`, émet `session.idle_too_long` après N minutes (config). Notifié Discord.
- `[G-4]` : healthcheck PTY pour détecter zombies + bouton "Hard Restart".

**Challenge** :
- Cas d'usage 2.4 du plan ("30 min en autonome") rend ce watchdog vraiment utile.
- `[G-4]` "Hard Restart" est dangereux : redémarrer une session perd son contexte de conversation. À reporter.
- L'ActivityMonitor coûte peu (un timer + un check) et c'est cohérent avec les notifs Discord déjà prévues.

**Décision** : ✅ **À appliquer (version Claude)**.
- Module `ActivityMonitor`, env `SWARM_OS_IDLE_TIMEOUT_MIN` (défaut 10 min).
- Émet event `session.idle_too_long` → notif Discord (orange).
- Hard Restart : ❌ rejeté MVP.

---

## T6. Cycle de vie des sessions

**Suggestions** :
- `[X-4]` : états plus fins (`starting/ready/busy/waiting/exiting/exited/failed/killed/interrupted`), règles de crash, délai SIGTERM→SIGKILL, idempotence DELETE, comportement double-call.
- `[G-7]` : "Exit Hook" — quand un worker meurt, envoyer auto au lead un message team-comms avec exit code + 5 dernières lignes de log.

**Challenge** :
- `[X-4]` propose 9 états ; le plan en a 6 (`starting/running/stopping/stopped` orch + `starting/running/waiting/exited/killed/interrupted` session). Ajouter `failed` et `busy` est utile ; `ready` se confond avec `running`.
- Le délai gracieux SIGTERM→SIGKILL et l'idempotence DELETE sont du basique non négociable.
- `[G-7]` (notif worker dead → lead) est une excellente UX et déjà pré-existante côté plan ("le lead est notifié via un message inséré dans son PTY"). Juste préciser le **payload** : exit code + tail du log.

**Décision** : ✅ **À appliquer**.
- Ajouter état `failed` (distinct de `killed` — crash sans intervention) et `busy` (en cours de tool).
- Délai gracieux : SIGTERM, attente 5s, puis SIGKILL.
- DELETE idempotent (200 si déjà stopped).
- Worker exit anormal → message auto en mailbox du lead avec `{ exit_code, last_log_lines: 20 }`.

---

## T7. Persistance enrichie + indexes SQLite

**Suggestions** :
- `[X-5]` : stocker `created_by`, `last_error`, `stop_reason`, `log_path`, `effective_config`. Indexes `sessions(orchestrator_id)`, `sessions(status)`, `orchestrators(status)`.
- `[G-6]` : index `sessions(orchestrator_id)`.

**Challenge** :
- Cheap et utile pour audit/debug.
- `effective_config` (model/effort/permissionMode/cwd réellement passés au spawn) est très utile pour reproduire un bug.
- `created_by` (`ui|mcp|api`) : redondant car déjà déductible par contexte ; rejeté.

**Décision** : ✅ **À appliquer (sauf `created_by`)**.
- Colonnes : `last_error`, `stop_reason`, `log_path`, `effective_config` (JSON).
- Indexes : `sessions(orchestrator_id)`, `sessions(status)`.

---

## T8. Limites opérationnelles & garde-fous

**Suggestions** :
- `[C-C15]` : `SWARM_OS_MAX_SESSIONS_PER_ORCH` (défaut 10).
- `[X-8]` : max orchestrateurs, max workers/orch, taille max prompt initial, taille max message, taille max log/session, timeout démarrage Claude, idle timeout, allowlist `cwd`.
- `[G-4]` : "Max Turns / Budget" par orchestrateur.

**Challenge** :
- Tout `[X-8]` est sage mais 7 limites = bruit. Garder les 4 qui protègent réellement le container.
- "Max Turns / Budget" est intéressant mais demande un compteur de turns côté swarm-os qu'on n'a pas → trop coûteux MVP.
- "Allowlist cwd" : déjà couvert par "doit être sous /workspace" + realpath check (T11).

**Décision** : ✅ **À appliquer (limites essentielles)**.
- `SWARM_OS_MAX_ORCHESTRATORS` (défaut 5).
- `SWARM_OS_MAX_SESSIONS_PER_ORCH` (défaut 10).
- `SWARM_OS_MAX_MESSAGE_SIZE_KB` (défaut 64).
- `SWARM_OS_CLAUDE_START_TIMEOUT_S` (défaut 30).
- Idle timeout déjà couvert par T5.
- Max Turns / Budget : ❌ reporté roadmap.

---

## T9. Auth WebSocket

**Suggestions** :
- `[C-B5]` : query param (logs!), sub-protocol (propre), ou ticket à usage unique.
- `[X-7]` : query token temporaire OU cookie HttpOnly OU sub-protocol ; allowlist d'origins ; rotation token ; masquage logs ; pas de token dans URL Discord.

**Challenge** :
- Sub-protocol `Sec-WebSocket-Protocol` est propre mais cassant côté navigateur (certains proxies le strippent).
- Ticket à usage unique : 2 lignes côté serveur, plus robuste.
- Allowlist origins : utile mais comme on est derrière Tailscale + token, le risque CSRF WS est marginal. Acceptable mais pas critique MVP.

**Décision** : ✅ **À appliquer (ticket WS)**.
- `POST /ws-ticket` (auth header) → `{ ticket, expires_at }` (TTL 10s, single-use, en mémoire).
- WS `/ws/sessions/:id?ticket=...` ; logs HTTP excluent le query string `ticket`.
- Token Discord URL : pas de token dans les URL, le frontend redirect via login si non auth.
- Allowlist origins : 🔵 documenté comme limite assumée v0.1.

---

## T10. UX du token initial

**Suggestions** :
- `[C-B6]` : print sur stdout container au premier boot (`docker logs`) + `docker exec ... cat /data/token` ; page paste-token côté frontend.
- `[X-7]` : rotation, masquage en logs.

**Challenge** :
- L'UX d'amorçage est trivialement nécessaire — sans ça, on ne peut pas se connecter à la première instance.
- Rotation : nice-to-have, pas critique single-user.

**Décision** : ✅ **À appliquer (basique)**.
- Premier boot : log INFO `[swarm-os] Auth token: <token> — store at /data/token`.
- Page `/login` : input token → localStorage.
- Rotation : ❌ reportée.
- Masquage : tous les logs HTTP doivent masquer header `X-Auth-Token` et query `ticket`.

---

## T11. Sécurité diverses (cwd, Docker, factualité)

**Suggestions** :
- `[C-B1]` : reformuler "classifier serveur Anthropic désactivé" → factuel : "désactive toutes les approbations CLI".
- `[C-B4]` : validation `cwd` = `realpath(cwd).startsWith('/workspace/')`.
- `[X-6]` : `init: true` dans compose ; ports `127.0.0.1:8787:8787` (binder localhost).
- `[G-3]` : Egress filtering.

**Challenge** :
- `[C-B1]` : 1 ligne, factuel, à corriger.
- `[C-B4]` : 5 lignes de code, indispensable.
- `[X-6]` : `init: true` (PID 1 = tini) gère les zombies = important pour un container qui spawn N PTY. `127.0.0.1` binding = critique sécurité.
- `[G-3]` Egress : déjà mentionné en §14 limites du plan, reporté roadmap.

**Décision** : ✅ **À appliquer (tout sauf egress)**.
- §14 reformulation factuelle.
- `realpath` check au create.
- Compose : `init: true` + ports `127.0.0.1:PORT:8787`.
- Egress : 🔵 reste roadmap, déjà documenté.

---

## T12. Modèle, effort, terminologie

**Suggestions** :
- `[C-A5]` + `[C-D]` : `opus-4-7` → `claude-opus-4-7` (ID réel) ; "effort" n'est pas un flag claude natif, soit mapper vers `--max-thinking-tokens`, soit acknowledger que c'est notion swarm-os.
- `[X-1]` : ne pas figer `opus-4-7`/`xhigh` dans les types métier ; strings validées par config.

**Challenge** :
- L'ID modèle exact dépend de l'env du user — confirmé : `claude-opus-4-7` est le bon (cf. context env).
- "Effort" comme notion swarm-os mappée vers `--max-thinking-tokens` est honnête.
- Types métier en strings + validation config = bonne pratique.

**Décision** : ✅ **À appliquer**.
- Renommer `opus-4-7` → `claude-opus-4-7` partout.
- Section "effort mapping" : `low: 1024 / medium: 4096 / high: 16384 / max: 32768` tokens, passé via `--max-thinking-tokens` (à valider en spike).
- Types : `model: string` + validateur runtime au lieu de literal type.

---

## T13. SDK MCP officiel & transport

**Suggestions** :
- `[C-C9]` + `[X-2]` : utiliser `@modelcontextprotocol/sdk` côté serveur TS plutôt que réimplémenter framing JSON-RPC over HTTP.
- `[G-6]` : implémenter SSE pour notifications serveur→client.

**Challenge** :
- Le SDK officiel évite des semaines de bugs sur edge cases du framing — choix évident, pas plus complexe.
- SSE : le transport "Streamable HTTP" du SDK MCP gère déjà ça. Pas besoin de réinventer.

**Décision** : ✅ **À appliquer**.
- Utiliser `@modelcontextprotocol/sdk` côté serveur (transport Streamable HTTP).
- L'abstraction `McpTransportAdapter` de `[X-2]` est inutile si on utilise le SDK — ❌ rejeté.

---

## T14. Discord : rate limit, payload, UX

**Suggestions** :
- `[C-B9]` : buffer + coalescing par orchestrateur (rate limit ~30/min).
- `[C-C14]` : payload "orch fini" enrichi (exit code, durée, nb messages, top 3 derniers messages lead).

**Challenge** :
- 30 req/min/webhook : facile à atteindre avec 5 orch actifs qui notifient chacun à intervalle.
- Coalescing via buffer 2-3s + flush en 1 embed à plusieurs fields : peu de code, gros bénéfice.
- Payload enrichi orch fini : 1 embed, ~5 fields, gain UX réel quand on regarde son tel.

**Décision** : ✅ **À appliquer**.
- `Notifier` interne : buffer 3s, max 1 embed/3s/orch, coalesce en multi-fields si plusieurs events.
- Embed "orch ended" : exit code, durée, sessions count, dernier message lead (truncate 200 chars).

---

## T15. Frontend WS contract & multi-attach

**Suggestions** :
- `[X-9]` : événements typés (`orchestrator.created`, `session.status_changed`, `session.output`, etc.) ; multi-attach ; mode read-only ; gestion resize.

**Challenge** :
- Définir le contrat d'events tôt évite des refactors UI.
- Multi-attach : 2 onglets sur la même session = use case réel (PC + tel). Read-only sur le second = clean.
- Resize : un must-have xterm.js (sinon affichage cassé sur mobile).

**Décision** : ✅ **À appliquer**.
- Liste d'events typés documentée dans `docs/ws-events.md`.
- Multi-attach autorisé ; **un seul "writer" à la fois**, les autres sont en read-only avec bouton "Take input".
- Resize : message WS `{ type: 'resize', cols, rows }`, propagé au PTY.

---

## T16. Quick-replies / interventions UI

**Suggestions** :
- `[C-C5]` : remonter "quick-replies" en MVP — textarea + bouton "Send" qui POST sur la session.
- `[G-5]` : champ "Global Broadcast" pour parler à toute l'équipe sans s'attacher.
- `[G-5]` : Vue Split Screen lead + worker.

**Challenge** :
- Quick-reply mobile : critique pour le cas d'usage 2.5 ("intervention depuis téléphone"). Sans, l'UX mobile xterm est insupportable.
- Global Broadcast : utile mais redondant si on a quick-reply + une "intervention humaine" qui peut viser l'orch entier (équivalent fonctionnel).
- Split Screen : nice-to-have, peut attendre v0.2.

**Décision** : ✅ **À appliquer (quick-reply seul)**.
- Composant `QuickReply` sous le terminal : textarea + "Send" → POST `/sessions/:id/input` (équivalent d'écrire dans le PTY).
- Bouton "Broadcast to team" qui injecte dans tous les PTY de l'orch.
- Split Screen : ❌ reporté v0.2.

---

## T17. Tests

**Suggestions** :
- `[C-C7]` : unit tests routeur MCP, e2e spawn lead/worker/send_message.
- `[X-12]` : interface `AgentProcess` pour fake claude ; smoke test Docker.

**Challenge** :
- L'interface `AgentProcess` (abstraction PTY+claude) permet de tester sans dépendre du LLM réel — vraiment important pour CI rapide.
- E2e avec claude réel : trop coûteux/flaky en CI, garder en manuel/scripts.

**Décision** : ✅ **À appliquer (Phase 7 nouvelle)**.
- Phase 7 "tests & polish" (1 jour) : interface `AgentProcess` + fake impl ; unit tests MCP routing, lifecycle, mailbox, cwd validation, lead-only permissions.
- E2e claude réel : `scripts/e2e-manual.sh` documenté, pas dans CI.

---

## T18. Event log structuré + CLAUDE.md + log rotation

**Suggestions** :
- `[C-C2]` : event log NDJSON structuré (`message_sent`, `worker_spawned`, `session_idle`).
- `[G-3]` : audit log centralisé des commandes shell.
- `[C-B11]` : mentionner que `CLAUDE.md` du workspace est lu auto par claude (voulu).
- `[C-B10]` : préciser politique log rotation (rename + gzip + N=5).

**Challenge** :
- NDJSON event log : trivial avec pino, énorme valeur post-mortem (bien plus exploitable qu'un PTY raw).
- Audit log shell `[G-3]` : doublon partiel du log PTY brut, et surtout demande de parser le PTY pour extraire les bash calls — coûteux. Rejeté MVP.
- CLAUDE.md mention : 1 ligne dans le plan, gratuit.
- Rotation policy concrète : doit être tranchée (sinon on logfille à 50MB et on plante). Choix : `pino-roll` (rename+gzip, garde 5).

**Décision** :
- ✅ Event log NDJSON `/data/logs/{orch_id}/events.ndjson`.
- ✅ Mention CLAUDE.md auto-loadé par claude (voulu, utile).
- ✅ Rotation : `pino-roll`, rename `.log.N`, gzip, garde 5.
- ❌ Audit log shell séparé.

---

## T19. MCP tools cleanup

**Suggestions** :
- `[C-C1]` : retirer `am_i_lead` (redondant avec `whoami.type === 'lead'`).
- `[C-B2]` : `team.list` — retourner que running/waiting, pas les exited.
- `[C-B3]` : `send_message({ to })` — id ou name ? Préférence id, name accepté avec doc.

**Challenge** :
- Tous corrects, peu coûteux.

**Décision** : ✅ **À appliquer**.
- Retirer `am_i_lead`.
- `team.list` → uniquement sessions actives (`running|waiting|busy`).
- `to` accepte id (préféré) ou name (résolu si unique, sinon erreur).

---

## T20. UI status badges + interrupted UX

**Suggestions** :
- `[C-C13]` : badges 🟢/🟡/🔵/⚪/🔴 par session.
- `[C-B12]` : panel "Interrupted on restart" + bouton Clear.

**Challenge** :
- Badges : trivial, gros gain visuel.
- Panel interrupted : bonne UX, peu de code.

**Décision** : ✅ **À appliquer**.

---

## T21. Variables d'env manquantes

**Suggestion** : `[C-C12]` : `SWARM_OS_LOG_LEVEL`, `SWARM_OS_MCP_PORT`, `SWARM_OS_IDLE_TIMEOUT`, `SWARM_OS_CLAUDE_BIN`.

**Décision** : ✅ **À appliquer (alignement avec T8 et T5)**.

---

## T22. Dockerfile multi-stage + healthcheck + version pinning

**Suggestions** :
- `[C-B7]` : multi-stage builder/runtime.
- `[C-B8]` : pinner `@anthropic-ai/claude-code@<version>`.
- `[C-C3]` + `[X-6]` : `HEALTHCHECK` Docker concret.

**Challenge** :
- Multi-stage : 30 lignes au lieu de 15, mais image runtime ~200MB plus légère.
- Pin claude CLI : critique pour reproductibilité.
- Healthcheck : ligne triviale, vraie valeur ops.

**Décision** : ✅ **À appliquer**.

---

## T23. Préambule par défaut — draft

**Suggestion** : `[C-C10]` + `[C-C11]` : inclure un draft de préambule lead (5-10 lignes) ; documenter convention "fin de tâche worker = `team.send_message DONE` ou `exit`".

**Décision** : ✅ **À appliquer**.
- Draft inline en §11 : identité + outils dispo + format messages entrants + convention DONE/exit + invitation à `team.read_inbox` régulier.

---

## T24. Effort estimé / re-découpage des phases

**Suggestions** :
- `[C-C6]` : 6 jours optimiste → 8-10 jours.
- `[X-10]` : 8 phases plus granulaires (spike → server → UI → MCP → workers → persist → discord → docker → polish).

**Challenge** :
- L'ajout de la mailbox + spike + tests pousse vers 8-10 jours réalistes, oui.
- Le découpage `[X-10]` séparant "UI terminal" avant "MCP" est intéressant mais inverse l'ordre de validation : si MCP ne marche pas, l'UI seule ne sert à rien. Garder un découpage proche du plan original avec ajout Phase 0bis et Phase 7.

**Décision** : ✅ **À appliquer (réaliste)**.
- Phase 0 (½) Bootstrap.
- Phase 0 bis (½) Spike claude/MCP/hooks.
- Phase 1 (1) Spawner + lead solo.
- Phase 2 (1,5) MCP via SDK officiel.
- Phase 3 (2) Workers + mailbox + team-comms.
- Phase 4 (1) Discord + persistance + watchdog idle.
- Phase 5 (1,5) Containerisation + multi-instance.
- Phase 6 (1) Polish UI (quick-reply, badges, interrupted panel, PWA).
- Phase 7 (1) Tests (AgentProcess fake + unit MCP/lifecycle).
- **Total : 10 jours**.

---

## T25. Corrections de détail (typos, paths, cohérences)

**Suggestions** : `[C-D]` table complète + `[X-11]` (modules/preambles vs orchestrator/preamble.ts ; route log `/sessions/:id/log` vs `/orchestrators/:id/sessions/:sid/log` ; React+Vite "CDN" vs bundle ; uuid v7 dépendance).

**Décision** : ✅ **À appliquer toutes**.
- Path préambules unique : `packages/server/src/modules/preambles/`.
- Route log canonique : `GET /sessions/:id/log`.
- "React + Vite (CDN)" → "React + Vite (bundle statique servi par Express)".
- `uuid v7` → ajouter `uuid` aux deps OU utiliser `crypto.randomUUID()` (v4) si l'ordre temporel n'est pas critique. **Décision : `crypto.randomUUID()` (v4)** — l'ordre temporel n'apporte rien dans nos use cases, et évite une dépendance.
- Vérifier le flag exact `--permission-mode bypassPermissions` vs `--dangerously-skip-permissions` lors du spike T2.
- `~/.claude` partagé multi-container : corrigé via T3.
- `POST /hooks/notification` : ajouter token `HOOK_TOKEN` env ou bind 127.0.0.1 only via auth path (déjà intra-container).

---

## T26. Rejets explicites (avec justification)

| Suggestion | Source | Raison du rejet |
|---|---|---|
| Egress filtering MVP | `[G-3]` | Déjà roadmap §14, vraie complexité réseau, pas critique single-user. |
| Audit log shell séparé | `[G-3]` | Doublon log PTY, parsing coûteux. |
| Hard Restart PTY session | `[G-4]` | Perd contexte de conversation, dangereux. |
| Vue Split Screen | `[G-5]` | Nice-to-have, complexité layout, reporter v0.2. |
| Indicateur de coût tokens | `[G-5]` | Pas d'API claude CLI pour ça actuellement, estimation grossière sans valeur. |
| Max Turns / Budget | `[G-4]` | Demande compteur turns custom non trivial, reporter v0.2. |
| `created_by` colonne | `[X-5]` | Déductible du contexte. |
| Allowlist origins WS | `[X-7]` | Tailscale + token déjà sufficient single-user. |
| Rotation token | `[X-7]` | Pas critique single-user, ajout complexité auth. |
| Délete-after-load mcp.json | `[C-A3]` | Fragile, gain marginal vs `session_secret` (T4). |
| Pattern matching PTY pour notifications | `[G-2]` | Fragile, fallback de dernier recours. |
| `am_i_lead` outil | `[C-C1]` confirme rejet du plan | Redondant avec `whoami`. |
| Bot Discord bidirectionnel | (plan) | Déjà roadmap v0.2. |

---

# Sommaire des suggestions à appliquer

> Liste actionnable des modifications à porter sur `plan.md`. Ordonnée par dépendance d'implémentation.

## A. Architecture (à intégrer avant Phase 1)

1. **Modèle hybride mailbox + signal PTY** (T1)
   - `team.send_message` → écrit en mailbox SQLite, retourne `{ message_id }`.
   - Signal court PTY si destinataire `idle` (état suivi via hooks).
   - Nouvel outil MCP `team.read_inbox({ since? })`.
   - Préambule par défaut force le poll après tâche.

2. **Spike Claude Code (Phase 0 bis, ½ jour)** (T2, T12, T25)
   - Valider : `--permission-mode bypassPermissions` vs `--dangerously-skip-permissions`, `--mcp-config`, `--max-thinking-tokens`, hooks `Notification`, comportement `~/.claude` RO, ID modèle exact.
   - Livrable : `scripts/verify-claude-code.ts` + `docs/claude-cli-validated.md`.

3. **Stratégie hooks via `CLAUDE_CONFIG_DIR` par session** (T2)
   - Dir `/data/runtime/orch-{id}/session-{id}/.claude/` avec `settings.json` pointant `Notification` → `POST http://127.0.0.1:8787/hooks/notification`.
   - Token `HOOK_TOKEN` interne pour défense en profondeur.

4. **Credentials claude : copy au boot vers volume privé** (T3)
   - Mount `~/.claude:ro` source → copy vers `/data/.claude-runtime/` au boot → `CLAUDE_CONFIG_DIR=/data/.claude-runtime`.
   - Empêche la corruption multi-instance.

5. **Auth MCP : `session_secret` séparé du `session_id`** (T4)
   - Path `/mcp/:orch_id/:session_secret`, secret jamais exposé UI/logs.
   - Limite "impersonation intra-container" documentée en §14.

## B. MCP & SDK

6. **Utiliser `@modelcontextprotocol/sdk` officiel** (T13) — transport Streamable HTTP, pas de re-implémentation custom.

7. **Outils MCP nettoyés** (T19)
   - Retirer `am_i_lead`.
   - Ajouter `team.read_inbox`.
   - `team.list` → sessions actives uniquement.
   - `team.send_message({ to })` accepte id ou name.

## C. Robustesse & lifecycle

8. **Cycle de vie enrichi** (T6)
   - Nouveaux états : `failed`, `busy`.
   - SIGTERM grace 5s puis SIGKILL.
   - DELETE idempotent.
   - Worker exit anormal → message auto en mailbox du lead avec `{ exit_code, last_log_lines: 20 }`.

9. **Watchdog idle** (T5)
   - Module `ActivityMonitor`, env `SWARM_OS_IDLE_TIMEOUT_MIN` (défaut 10).
   - Notif Discord orange.

10. **Limites opérationnelles** (T8)
    - `SWARM_OS_MAX_ORCHESTRATORS` (5), `SWARM_OS_MAX_SESSIONS_PER_ORCH` (10), `SWARM_OS_MAX_MESSAGE_SIZE_KB` (64), `SWARM_OS_CLAUDE_START_TIMEOUT_S` (30).

11. **Persistance enrichie + indexes** (T7)
    - Colonnes : `last_error`, `stop_reason`, `log_path`, `effective_config` (JSON).
    - Indexes : `sessions(orchestrator_id)`, `sessions(status)`.

## D. Sécurité & auth

12. **Validation `cwd` rigoureuse** (T11) — `realpath(cwd).startsWith('/workspace/')`.

13. **Auth WebSocket via ticket** (T9)
    - `POST /ws-ticket` → ticket TTL 10s single-use.
    - `?ticket=...` masqué dans logs.

14. **UX token initial** (T10) — print stdout au boot + `/data/token` + page `/login` paste.

15. **Reformulation factuelle bypassPermissions** (T11) — pas d'affirmation sur le classifier serveur.

## E. Containerisation

16. **Dockerfile multi-stage + pin CLI + healthcheck** (T22)
    - Build/runtime séparés.
    - `RUN npm install -g @anthropic-ai/claude-code@<version-validée-spike>`.
    - `HEALTHCHECK --interval=30s CMD curl -fs http://127.0.0.1:8787/health`.

17. **Compose : `init: true` + bind localhost** (T11) — `127.0.0.1:8787:8787`.

## F. UI/UX

18. **Quick-reply + Broadcast** (T16) — textarea + boutons sous le terminal (mobile-friendly).

19. **Status badges sessions** (T20) — 🟢 running / 🟡 waiting / 🔵 idle / ⚪ exited / 🔴 killed/failed.

20. **Panel "Interrupted on restart"** (T20) — affichage + bouton Clear.

21. **Multi-attach WS** (T15) — un writer, autres read-only avec "Take input" ; resize propagé.

22. **Events WS typés documentés** (T15) — `docs/ws-events.md`.

## G. Observabilité

23. **Event log NDJSON** (T18) — `/data/logs/{orch_id}/events.ndjson`.

24. **Log rotation `pino-roll`** (T18) — rename, gzip, garde 5.

25. **Notifs Discord coalescées + payload riche orch ended** (T14).

## H. Modèle & terminologie

26. **`claude-opus-4-7` partout** + mapping effort → `--max-thinking-tokens` (T12).

27. **Model field = `string` validé runtime** (T12) — pas de literal type.

## I. Documentation & tests

28. **Préambule lead drafté inline** (T23).

29. **Mention `CLAUDE.md` auto-loadé** (T18).

30. **Phase 7 tests + interface `AgentProcess`** (T17).

## J. Détails à corriger

31. **Path préambules unifié** : `packages/server/src/modules/preambles/` (T25).

32. **Route log canonique** : `GET /sessions/:id/log` (T25).

33. **`crypto.randomUUID()` (v4)** au lieu de `uuid v7` (T25).

34. **"React + Vite (CDN)" → "bundle statique servi par Express"** (T25).

35. **Vars env complétées** : `SWARM_OS_LOG_LEVEL`, `SWARM_OS_MCP_PORT`, `SWARM_OS_IDLE_TIMEOUT_MIN`, `SWARM_OS_CLAUDE_BIN`, `HOOK_TOKEN` (T21).

---

## Effort total révisé : **10 jours** (vs 6 estimés initialement)

Phases : 0 (½) + 0bis (½) + 1 (1) + 2 (1,5) + 3 (2) + 4 (1) + 5 (1,5) + 6 (1) + 7 (1).
