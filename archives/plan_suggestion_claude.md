# swarm-os — Plan : suggestions & corrections

> Analyse critique de `plan.md`. Organisé par sévérité.
> Sections numérotées renvoient au plan.md (`§N`).

---

## A. Problèmes critiques (à trancher avant de coder)

### A1. Communication inter-sessions via écriture PTY stdin — fragile

§11 propose `team.send_message` qui écrit dans le PTY stdin du destinataire un bloc texte préformaté. C'est risqué :

- **Mid-turn corruption** : si la session destinataire est en cours de génération (claude raisonne, exécute un tool), l'écriture stdin est bufferisée par le terminal et risque de se mélanger avec d'autres entrées ou d'être interprétée hors contexte. Le comportement de claude CLI face à des paquets stdin pendant un tool call n'est pas garanti.
- **Pas d'accusé de réception** : `delivered: boolean` retourné par `send_message` ne signifie en réalité que "j'ai écrit dans le FD", pas "claude a vu le message".
- **Pas d'idempotence** : un retry peut doubler le message.
- **Echo loop** : si la session destinataire considère ça comme du user input, elle peut répondre… à qui ? Au lead via un autre `send_message` ? Le préambule doit l'encourager, mais c'est implicite.

**Suggestions** :
1. **Modèle "mailbox + tool"** plutôt que stdin push : exposer `team.read_inbox` côté destinataire et stocker les messages côté MCP serveur. Le préambule du destinataire indique de poll `read_inbox` après chaque tâche. Plus prédictible, idempotent, et persistable en DB.
2. À défaut, **n'écrire stdin que quand `Stop` hook a tiré** (la session est en attente). Suivre l'état `idle/busy` par session côté serveur via les hooks `PreToolUse`/`PostToolUse`/`Stop`. Bufferer les messages en attente et flush au passage en `idle`.
3. Spécifier la sémantique de `delivered` (écrit vs traité) — sinon les agents leads vont mal raisonner sur leurs envois.

### A2. Hooks Claude Code : où sont-ils configurés ?

§Phase 4 mentionne "Hook `Notification` global Claude Code → POST `/hooks/notification`". Mais :

- `~/.claude` est monté **read-only** (§5, §13, §14). Donc swarm-os ne peut **pas** écrire `~/.claude/settings.json` pour installer le hook.
- Écrire `.claude/settings.json` dans `/workspace` mute le repo de l'utilisateur (mauvais).
- Claude Code supporte `--settings <path>` ? À vérifier ; sinon utiliser `CLAUDE_CONFIG_DIR` env var pour pointer vers un dir contrôlé par swarm-os.

**À spécifier explicitement dans le plan** : la stratégie d'injection de hooks. Option recommandée : par session, écrire un `settings.json` dans un dir contrôlé (ex: `/data/runtime/orch-{id}/session-{id}/.claude/settings.json`) et lancer claude avec `CLAUDE_CONFIG_DIR` pointé dessus, OU passer `--settings` si supporté. Le mount RO de `~/.claude` reste pour les **credentials**, pas pour la config.

### A3. Auth MCP : impersonation entre sessions du même container

§14 dit "Auth MCP par UUID dans le path, bind localhost intra-container" + "Fichiers `mcp.json` temporaires en `/tmp/swarm-os/...`, mode `0600`".

Problème : toutes les sessions tournent sous le même user (`node`). `chmod 600` ne protège pas contre les lectures du même uid. Une session worker peut donc `cat /tmp/swarm-os/orch-X/session-Y/mcp.json`, récupérer l'UUID d'une autre session et l'imiter (appeler `team.kill_all_workers` en se faisant passer pour le lead, etc.).

**Suggestions** :
- Après le spawn de claude, **supprimer le mcp.json** dès que le process l'a chargé (claude le lit au démarrage). Faisable avec un délai court ou un sentinel.
- À défaut, isoler par sous-utilisateur (overkill pour MVP).
- Mieux : passer la config MCP via **stdin** ou variable d'environnement éphémère du processus (le `/proc/<pid>/environ` est readable par même-uid mais pas par autres uids ; ici c'est le même uid mais au moins ça n'apparaît pas sur le FS persistant).
- Si on garde le fichier, ajouter un check côté MCP serveur : compare l'UUID avec `peercred` (impossible en HTTP) → renoncer et accepter la limite, ou poser un challenge applicatif (jamais retourner d'info sensible avant un `whoami` qui valide le contexte d'exécution).

À **mentionner explicitement** comme "limite connue du modèle de sécurité" en §14 si non corrigé, parce qu'aujourd'hui le plan présente l'auth path-based comme suffisante.

### A4. Détection "session bloquée" insuffisante via le seul hook `Notification`

§Phase 4 : "Détection 'en attente d'humain' via hook `Notification`". Mais :

- Le hook `Notification` fire quand claude demande une permission ou attend une input. **Une session qui tourne en boucle dans un tool, qui plante silencieusement, ou qui est entrée en bypassPermissions et exécute long → pas de notif.**
- Pour de l'autonome long (cas d'usage §2.4 : 30 min), il faut un **watchdog** indépendant qui détecte l'inactivité (pas de PTY output depuis N minutes) et notifie.

**Suggestion** : ajouter un module `ActivityMonitor` qui suit `lastActivityAt` par session et émet un event `session.idle_too_long` configurable (par défaut 10 min sans output). Notifié via Discord. À mentionner en §scope MVP.

### A5. Nom de modèle et "effort" — termes à clarifier

§4 & §8 : `defaultModel: 'opus-4-7'`, `defaultEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'`.

- L'ID de modèle Claude actuel est **`claude-opus-4-7`** (pas `opus-4-7`). À aligner partout (§4, §5, §8, §9 body example, §13 env defaults, §17).
- **"effort: xhigh"** n'est pas un paramètre Claude Code natif. Claude Code CLI accepte `--model` mais pas un flag "effort" standard. Si tu vises le contrôle du **thinking budget**, le paramètre est `--max-thinking-tokens` (ou via SDK). À reformuler en termes concrets : par exemple un mapping `effort → max-thinking-tokens` (`low: 1024`, `medium: 4096`, `high: 16384`, `max: 32768`) documenté.
- À défaut, expliciter que "effort" est une notion **swarm-os**, pas un flag claude natif, et décrire le mapping.

### A6. `~/.claude` monté en read-only — vérifier compatibilité claude CLI

§13 et §14 montent `~/.claude` en RO. Claude CLI écrit dans ce dir :
- `~/.claude/projects/<hash>/` (historique de conversation)
- `~/.claude/todos/`
- `~/.claude/statsig/` etc.

Si le mount est strictement RO, claude CLI peut crasher ou logguer des erreurs en boucle.

**Suggestion** : monter seulement le **dossier credentials** (ex: `~/.claude/.credentials.json` selon version, ou tout `~/.claude` en RW mais dans un copy-on-write au démarrage, ou monter en RW et accepter la limite). À tester en Phase 5 explicitement. Mettre à jour §14 si la décision diverge.

### A7. Plusieurs containers partagent **le même** `~/.claude` — conflit

§3 (vue multi-instance) et §13 montrent tous les containers montant `~/.claude:/home/node/.claude:ro` du host. Si chaque container écrit dans `~/.claude/projects/<hash>/` (même en cherchant à contourner le RO via override), il y aura **conflit d'écriture / corruption** entre instances. Même en RO, plusieurs claude qui lisent les mêmes sessions et indexes en parallèle pose question.

**Suggestion** : par container, **copier au démarrage** les credentials dans un volume privé (`/data/.claude-runtime`) plutôt que de mount-share `~/.claude`. Chaque instance a son propre `CLAUDE_CONFIG_DIR`. Section §13 à reformuler.

---

## B. Problèmes importants (à corriger avant Phase 1)

### B1. `--permission-mode bypassPermissions` + auth Anthropic — préciser le risque

§14 dit "le classifier serveur d'Anthropic est aussi désactivé". À vérifier : bypassPermissions désactive l'approbation côté CLI, pas nécessairement le classifier serveur (qui n'est pas mentionné dans la doc publique Claude Code). **Reformuler factuellement** : "désactive toutes les approbations côté CLI ; l'agent peut appeler tous les outils incluant Bash sans interruption". Éviter d'affirmer ce qui n'est pas sûr.

### B2. `team.list` — comportement face aux sessions exited

§10 ne précise pas si `team.list` retourne les sessions terminées. Décidez :
- Option : ne retourner que les sessions `running`/`waiting` (vue "vivante").
- Mentionner si on inclut `exited` avec marqueur.

Idem pour `team.broadcast` : envoie seulement aux sessions actives.

### B3. `team.send_message({ to, ... })` — `to` = id ou name ?

§10 dit `to` sans type. Le name est plus naturel pour le lead ("envoie à `pr-142`"), mais ambigu (deux workers du même nom). **Décider** : accepter id OU name avec préférence à l'id ; documenter dans le préambule par défaut.

### B4. Validation `cwd` sous `/workspace` — préciser la rigueur

§8 dit "doit être sous `/workspace`". Implémentation correcte = `realpath(cwd).startsWith('/workspace/')` après résolution des symlinks. À mentionner explicitement, sinon un agent peut passer `/workspace/../etc` ou un symlink échappatoire.

### B5. WebSocket auth — non spécifiée

§9 liste `/ws/sessions/:id` et `/ws/events` mais §14 décrit seulement l'auth header REST. Une WS ne peut pas porter un header `X-Auth-Token` côté navigateur ; il faut passer le token en :
- **query param** (`?token=...`) — apparaît dans les logs.
- **sub-protocol WS** (`Sec-WebSocket-Protocol`) — propre, recommandé.
- ou via un **ticket** : `POST /ws-ticket` (auth via header) retourne un ticket à usage unique consumé par la WS.

Spécifier le choix dans §9.

### B6. Token initial — UX d'amorçage

§Phase 6 dit "Auth token init au premier boot (généré, écrit dans `/data/token`)". Comment l'utilisateur le récupère ? À spécifier :
- Print sur **stdout du container au premier boot** (visible via `docker logs`).
- ET disponible via `docker exec swarm-os cat /data/token`.
Le frontend doit avoir une page de **paste-token** (stocker en localStorage) avant le premier accès.

### B7. Multi-stage Dockerfile

§13 montre un Dockerfile single-stage qui garde toutes les devDeps + sources TS. Pour une image plus légère et moins de surface :
```
FROM node:24-bookworm-slim AS builder
... pnpm install + build
FROM node:24-bookworm-slim AS runtime
... copy dist + prod deps + claude CLI
```
Pas critique pour MVP mais à noter.

### B8. Version pinning du CLI claude

§13 : `RUN npm install -g @anthropic-ai/claude-code` sans version. Reproductibilité cassée : un rebuild dans 3 mois prend une autre version. Pinner explicitement (`@1.x` ou version exacte) et bumper consciemment.

### B9. Rate limit Discord

Discord webhooks ont une limite ~30 req/min. Plusieurs orchestrateurs actifs peuvent dépasser. **Suggestion** : un buffer + coalescing par orchestrateur dans `Notifier` (regrouper plusieurs events proches en un seul embed). À noter en §12.

### B10. Log rotation — politique exacte

§Phase 4 dit "rotation à 50 MB" sans détails. Préciser :
- Stratégie : rename `.log → .log.1`, gzip, garde N=5 ?
- Lib utilisée (pino-rotating-file, log-rotation manuelle, logrotate dans le container) ?

### B11. CLAUDE.md du projet

Pas mentionné. Quand un orchestrateur tourne avec `cwd=/workspace/sub`, claude lit automatiquement `/workspace/CLAUDE.md` et `/workspace/sub/CLAUDE.md` et `~/.claude/CLAUDE.md`. À mentionner explicitement dans le plan que c'est **voulu et utile** (le project memory file devient le contexte par défaut de l'équipe).

### B12. Reprise après restart : protocole de "interrupted"

§Phase 4 : "reprise au démarrage marque les sessions actives comme `interrupted`". OK mais :
- L'utilisateur retrouve une liste d'orchestrateurs morts au reload. Ergonomie ?
- Suggestion : afficher un panel "Interrupted on restart" en haut de l'UI avec bouton "Clear".
- Préciser dans le plan que **toutes les sessions PTY sont perdues** au restart container (pas de live-migration). Mentionner explicitement comme limite.

---

## C. Améliorations (nice-to-have)

### C1. `am_i_lead` redondant

§10 : `am_i_lead` retourne `{ is_lead: boolean }`. Déjà déductible de `whoami.type === 'lead'`. À retirer pour simplifier la surface MCP.

### C2. Event log structuré

Le plan ne mentionne qu'un log PTY brut. Pour debug et review post-mortem, ajouter un **event log structuré** (NDJSON) par orchestrateur :
```
{ ts, type: "message_sent", from, to, content_preview }
{ ts, type: "worker_spawned", id, role }
{ ts, type: "session_idle", id }
```
Beaucoup plus exploitable que le PTY raw pour comprendre "qu'est-ce qui s'est passé".

### C3. Healthcheck Docker concret

§15 mentionne `/health`. Ajouter dans Dockerfile :
```
HEALTHCHECK --interval=30s CMD curl -fs http://127.0.0.1:8787/health || exit 1
```

### C4. PWA mobile — détails xterm.js

§Phase 6 mentionne PWA manifest + SW. Pour xterm.js sur mobile :
- Pas de copier-coller terminal natif → prévoir un **bouton "scroll lock"** et un **textarea d'input** alternatif pour les longues consignes (au lieu de taper char-by-char).
- Le scroll virtuel xterm peut bugger sur iOS. Tester en Phase 6.

### C5. Quick-replies depuis l'UI (déplacer de roadmap → MVP)

§16 liste "Quick-replies UI" en post-MVP, mais c'est l'**ergonomie clef du cas d'usage 2.5** ("intervention depuis mobile"). Sans, l'utilisateur doit ouvrir un terminal xterm.js mobile pour taper sa réponse, ce qui est pénible. Un simple textarea + bouton "Send to lead" / "Send to session X" qui POST sur le `/ws/sessions/:id` revient pas cher et change l'usage. À considérer pour v0.1.

### C6. Effort estimé — 6 jours = optimiste

§6 totalise 6 jours :
- Phase 0 (½) — OK
- Phase 1 (1) — OK
- Phase 2 (1) — **serré** : implémenter MCP streamable HTTP de zéro prend plus que prévu si tu ne réuses pas le SDK officiel `@modelcontextprotocol/sdk`.
- Phase 3 (1,5) — **très serré** vu la complexité PTY-stdin + préambule + UI.
- Phase 4 (1) — OK
- Phase 5 (1) — réaliste si tu n'as pas de surprise sur RO `~/.claude`.
- Phase 6 (½) — OK

Réaliste : **8–10 jours**, avec une phase 7 de stabilisation/tests d'1 jour à ajouter.

### C7. Tests — absents du plan

Aucune mention de stratégie de test. Pour un projet avec autant de surface PTY/MCP/IPC, prévoir au moins :
- Tests unitaires sur le routeur MCP (mock du PTY).
- Test e2e "spawn lead → spawn worker → send_message → assert reception" avec claude réel dans un container CI (peut nécessiter un mock LLM).
- À mentionner en Phase 6 ou nouvelle Phase 7.

### C8. Multi-stage logging niveaux

§15 ne précise pas les niveaux de log. Pino supporte `level` par module. Préciser : `info` pour le serveur, `debug` opt-in via env.

### C9. Section §4 — manquant : transport MCP

§4 liste "MCP serveur : Code custom léger, transport Streamable HTTP". Évaluer concrètement l'utilisation du **SDK officiel `@modelcontextprotocol/sdk`** côté serveur (TypeScript). Ça évite de réimplémenter le framing JSON-RPC over HTTP/SSE. À mentionner et trancher.

### C10. Préambule par défaut — préciser le contenu

§Phase 3 : "défaut versionné dans `packages/server/src/preambles/`". Le plan ne montre pas de draft. Suggestion : inclure un **bloc draft du préambule lead** dans le plan (5-10 lignes) pour cadrer l'implémentation et le ton attendu.

### C11. Convention de fin de tâche d'un worker

Si un worker termine sa tâche, comment signale-t-il au lead ?
- Option 1 : Il appelle `team.send_message({ to: lead, content: "DONE: ..." })`.
- Option 2 : Il `exit` (le PTY se ferme, lead reçoit une notif).

À documenter dans le préambule par défaut + le plan §11.

### C12. Variables d'env — manquantes

§13 table des env vars ne mentionne pas :
- `SWARM_OS_LOG_LEVEL`
- `SWARM_OS_MCP_PORT` (override 8788)
- `SWARM_OS_IDLE_TIMEOUT` (pour A4)
- `SWARM_OS_CLAUDE_BIN` (override chemin du CLI claude)

### C13. UI : indicateur d'état de la session

Pas mentionné. Sur le panneau des sessions, afficher un badge :
- 🟢 running / 🟡 waiting / 🔵 idle / ⚪ exited / 🔴 killed.

À ajouter en §Phase 1 (basique) puis enrichi en Phase 4.

### C14. Notification "orch fini" — payload

§12 dit "Orchestrateur exit (lead terminé) avec son statut". Préciser le payload : exit code, durée, nombre de messages échangés, top 3 derniers messages du lead — utile pour décider si on regarde ou pas.

### C15. Limit on number of concurrent sessions

Pas de cap. Un lead pourrait spawn 50 workers et OOM le container. Suggestion : `SWARM_OS_MAX_SESSIONS_PER_ORCH` env (défaut 10), retour `LIMIT_REACHED` côté MCP.

---

## D. Corrections de détail (typos, incohérences)

| Loc | Actuel | Correction |
|---|---|---|
| §4, §5, §8, §9, §13 (env), §17 | `opus-4-7` | `claude-opus-4-7` (ID modèle réel) |
| §5 (defaultEffort) + §8 (interface Session) | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | Aligner avec mapping concret (cf. A5) ; et `Session.effort` doit accepter les mêmes valeurs |
| §5 | "modèle Opus 4.7 + effort xhigh par défaut" | Préciser que "effort" est une notion swarm-os et donner le mapping |
| §3 (ASCII) | `8788/mcp/X/sessions/L` | Cohérent avec §9 qui dit `/mcp/:orch_id/sessions/:session_id` — OK, juste vérifier que `L` désigne bien le `session_id` du lead |
| §6 Phase 3 | "Préambule paramétrable : un défaut versionné dans `packages/server/src/preambles/`" | §7 montre le path comme `packages/server/src/modules/preambles/` (avec `modules/`). Aligner. |
| §7 (struct) | `default-lead.md` puis `default-worker.md` séparés par retour à la ligne sans `│` | Bug de l'arborescence ASCII : un `│` manque ou la branche se ferme mal |
| §9 (REST table) | `POST /hooks/notification` | Préciser que ce endpoint est **non authentifié** (les hooks tournent dans le container, sur 127.0.0.1) OU exige un token séparé (HOOK_TOKEN env) pour défense en profondeur. |
| §12 (embed) | `"url": "https://swarm.tail-xyz.ts.net:8787/orchestrators/{id}"` | Construire à partir de `SWARM_OS_PUBLIC_URL` ; expliciter qu'on omet `url` si l'env est absente (§13 le dit, à rappeler en §12). |
| §13 (compose multi) | Deux services montent `~/.claude:/home/node/.claude:ro` partagé | cf. A7 — corriger l'architecture pour ne pas partager le même dir entre containers |
| §13 (env vars table) | `SWARM_OS_TOKEN` non obligatoire | OK, mais l'UX de récupération du token généré (cf. B6) doit être documentée |
| §17 (decisions) | "8788 MCP (intra-container)" | Cohérent — bon |
| §1 | "Toutes les sessions tournent en `--permission-mode bypassPermissions`" | Vérifier l'argument exact de claude CLI (`--permission-mode=bypassPermissions` ou `--dangerously-skip-permissions` ?). Selon la version du CLI, le nom diffère. À pinner avec la version (B8). |

---

## E. Questions ouvertes à trancher

1. **PTY-stdin push vs mailbox-poll** pour `send_message` (cf. A1) — décide ça avant Phase 3, c'est structurant.
2. **Stratégie hooks Claude Code** (cf. A2) — à valider tôt en Phase 4, idéalement spike en Phase 0.
3. **Partage `~/.claude` entre containers** (cf. A6, A7) — à valider en Phase 5 par un test.
4. **Quick-replies UI en v0.1 ou v0.2** (cf. C5).
5. **SDK MCP officiel ou code custom** (cf. C9).
6. **Worker fin de tâche : exit ou message ?** (cf. C11).
7. **Cap concurrent sessions** (cf. C15).
8. **MCP path-based auth : on accepte la limite d'impersonation intra-container ?** (cf. A3).

---

## F. Synthèse — ordre de priorité d'action

1. **Trancher A1** (modèle de messagerie) — sans ça, Phase 3 est dans le flou.
2. **Trancher A2** (hooks setup) — bloque Phase 4.
3. **Corriger D** (model ID, paths, names) — 30 min, à faire tout de suite.
4. **Documenter A5** (effort → max-thinking-tokens mapping).
5. **Décider A6/A7** (mount `~/.claude`).
6. **Ajouter §scope** : A4 (idle watchdog), B5 (WS auth), B6 (token UX), C2 (event log), C5 (quick-replies).
7. **Re-estimer effort** : 8–10 jours (C6), avec une Phase 7 tests (C7).
8. **Acknowledger A3** comme limite connue si non corrigé.
