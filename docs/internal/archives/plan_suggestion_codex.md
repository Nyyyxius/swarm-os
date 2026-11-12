# Suggestions Codex — corrections et améliorations pour `plan.md`

Analyse du plan MVP `swarm-os`, avec priorité aux points qui peuvent bloquer l'implémentation ou créer une dette difficile à corriger après coup.

## 1. Valider les hypothèses Claude Code avant de coder le coeur

Le plan dépend fortement de détails CLI qui doivent être traités comme instables tant qu'ils ne sont pas validés dans l'environnement cible :

- `--permission-mode bypassPermissions`
- `--mcp-config`
- format exact du fichier MCP accepté par Claude Code
- nom du modèle par défaut `opus-4-7`
- notion d'`effort: xhigh`
- hook `Notification` et son mode de transport

Correction recommandée :

- Ajouter une **Phase 0 bis — Spike Claude Code** avant le bootstrap serveur.
- Livrable : un script manuel ou automatisé dans `scripts/verify-claude-code.ts` qui vérifie `claude --version`, lance une session avec MCP local minimal, teste un appel tool, teste le hook notification, et documente les flags réellement supportés.
- Ne pas figer `opus-4-7` / `xhigh` dans les types métier tant que la CLI n'a pas confirmé ces valeurs. Utiliser des strings validées par config, avec défauts configurables.

Raison : si une seule de ces hypothèses est fausse, les phases 2 à 4 changent fortement. Le spike réduit le risque tôt.

## 2. Séparer transport MCP, protocole MCP et outils `team.*`

Le plan mélange "MCP HTTP serveur", "Streamable HTTP transport" et routes custom `POST /mcp/:orch_id/sessions/:session_id`. C'est faisable, mais il faut éviter d'implémenter un quasi-MCP incompatible avec les clients réels.

Corrections recommandées :

- Créer une abstraction `McpTransportAdapter` isolée de `TeamTools`.
- Tester l'endpoint avec un vrai client MCP ou Claude Code dès la Phase 2.
- Documenter dans `docs/mcp-protocol.md` :
  - méthode HTTP attendue,
  - headers requis,
  - format JSON-RPC exact,
  - gestion des sessions MCP,
  - erreurs standardisées.
- Prévoir une route interne non exposée mais avec secret fort, par exemple `/mcp/:orch_id/:session_secret`, plutôt que seulement `orch_id + session_id`.

Raison : `session_id` et `orch_id` peuvent apparaître dans logs/UI. Les utiliser comme unique secret d'accès MCP est fragile.

## 3. Revoir la communication par injection directe dans `stdin`

L'écriture directe dans le PTY est simple, mais elle peut corrompre une interaction en cours : commande shell interactive, prompt de confirmation, éditeur, test qui lit stdin, ou Claude en train d'émettre du texte.

Correction minimale MVP :

- Garder l'injection PTY, mais ajouter une **mailbox persistée légère** par session.
- `team.send_message` écrit d'abord dans la mailbox, puis injecte un court signal dans le PTY seulement si la session est considérée inactive.
- Ajouter `team.get_messages({ after? })` ou `team.read_inbox()` pour que Claude puisse récupérer les messages proprement.
- Journaliser `message_id`, sender, recipient, timestamp, delivery mode.

Raison : la mailbox donne un mécanisme fiable sans perdre l'ergonomie du push.

## 4. Définir précisément le cycle de vie des sessions

Le plan dit qu'un lead qui exit stoppe l'orchestrateur et qu'un worker qui exit notifie le lead, mais il manque les transitions d'état et les règles de redémarrage.

À ajouter :

- États distincts : `starting`, `ready`, `busy`, `waiting`, `exiting`, `exited`, `failed`, `killed`, `interrupted`.
- Règles explicites :
  - que faire si le lead crash au démarrage,
  - que faire si un worker crash avant d'avoir lu son prompt initial,
  - délai de kill gracieux avant `SIGKILL`,
  - comportement si `DELETE /orchestrators/:id` est appelé deux fois,
  - possibilité ou non de redémarrer un worker.
- Toujours envoyer au lead les 20 dernières lignes de log quand un worker sort anormalement.

Raison : les bugs de lifecycle sont difficiles à diagnostiquer avec des PTY long-running.

## 5. Rendre la persistance suffisante pour la reprise

Le plan stocke `orchestrators`, `sessions` et les logs, mais les processus PTY ne peuvent pas être repris après restart du serveur/container.

Corrections recommandées :

- Documenter clairement que la reprise v0.1 est une reprise **d'état historique**, pas une reprise de processus.
- Au boot, marquer toute session non terminale comme `interrupted`.
- Stocker aussi :
  - `created_by` ou source de création (`ui`, `mcp`, `api`),
  - `last_error`,
  - `stop_reason`,
  - chemin du log,
  - configuration effective utilisée au spawn.
- Ajouter indexes SQLite :
  - `sessions(orchestrator_id)`,
  - `sessions(status)`,
  - `orchestrators(status)`.

Raison : sans config effective persistée, il sera dur d'auditer ou de rejouer une création ratée.

## 6. Corriger les hypothèses Docker et credentials

Le montage `~/.claude:/home/node/.claude:ro` est une bonne intention sécurité, mais il peut casser si Claude Code doit écrire dans son répertoire de config/cache.

Corrections recommandées :

- Tester explicitement Claude Code avec `.claude` en read-only dans la phase spike.
- Si la CLI doit écrire, séparer :
  - credentials/config source en read-only,
  - cache/runtime dans `/data/claude-home` ou `/tmp/claude`.
- Ne jamais monter le home complet.
- Ajouter `init: true` dans les exemples Compose pour mieux gérer les processus enfants.
- Ajouter un healthcheck Docker qui appelle `/health`.
- Mapper le port main sur localhost seulement dans les exemples :
  - `"127.0.0.1:8787:8787"`
  - `"127.0.0.1:8797:8787"`

Raison : la section sécurité dit "jamais exposé internet public", mais les exemples `ports: "8787:8787"` écoutent généralement sur toutes les interfaces host.

## 7. Durcir l'auth HTTP et WebSocket

Un token statique en `X-Auth-Token` suffit pour un usage personnel, mais le plan doit préciser les détails qui piègent souvent les WebSockets et l'UI mobile.

À ajouter :

- Méthode d'auth WS : query token temporaire, cookie `HttpOnly`, ou sous-protocole WS.
- Rotation/régénération du token dans `/data/token`.
- Refus des requêtes sans `Origin` attendu, ou allowlist d'origins.
- Masquage du token dans logs serveur, logs d'accès et UI.
- Expiration courte pour les deep-links Discord si un token est inclus. Idéalement, ne jamais mettre le token dans l'URL Discord.

Raison : les URLs finissent dans historiques navigateur, logs proxy et previews Discord.

## 8. Ajouter limites et garde-fous dès le MVP

Le mode `bypassPermissions` dans un container est cohérent avec l'objectif, mais il manque des limites opérationnelles simples.

À ajouter dans la config :

- nombre max d'orchestrateurs actifs,
- nombre max de workers par orchestrateur,
- taille max du prompt initial,
- taille max d'un message `team.send_message`,
- taille max de log par session avec stratégie de rotation,
- timeout de démarrage Claude,
- idle timeout optionnel,
- allowlist optionnelle de `cwd` sous `/workspace`.

Raison : sans limites, une boucle de spawn ou de messages peut saturer le container et rendre l'UI inutilisable.

## 9. Préciser le modèle frontend temps réel

Le plan mentionne `/ws/events` et `/ws/sessions/:id`, mais pas le contrat d'événements ni la gestion multi-attache.

Corrections recommandées :

- Définir les événements serveur :
  - `orchestrator.created`
  - `orchestrator.updated`
  - `session.created`
  - `session.status_changed`
  - `session.output`
  - `session.exited`
  - `notification.created`
- Décider si plusieurs navigateurs peuvent être attachés au même PTY.
- Différencier "lecture du terminal" et "écriture dans stdin" : un mode read-only peut éviter les erreurs depuis mobile.
- Gérer explicitement le resize terminal (`cols`, `rows`) et le dernier client actif.

Raison : xterm.js fonctionne bien, mais les conflits d'input entre plusieurs clients sont une source fréquente de bugs.

## 10. Revoir le découpage des phases

Les durées semblent optimistes pour un système PTY + MCP + Docker + UI temps réel. Le risque n'est pas le volume de code, mais l'intégration.

Découpage recommandé :

- Phase 0 : spike Claude Code + MCP + hooks + Docker credentials.
- Phase 1 : serveur minimal + PTY lead solo + logs.
- Phase 2 : UI terminal robuste + auth + WS.
- Phase 3 : MCP compatible validé par Claude Code.
- Phase 4 : workers + mailbox + team tools.
- Phase 5 : persistance + lifecycle + reprise historique.
- Phase 6 : Discord + deep-links.
- Phase 7 : Docker Compose multi-instance + docs.
- Phase 8 : polish mobile/PWA.

Raison : l'UI terminal et le lifecycle devraient arriver avant la complexité multi-agent, sinon les bugs MCP et PTY se mélangeront.

## 11. Corriger quelques incohérences de structure

Points à ajuster dans `plan.md` :

- La section 7 indique `packages/server/src/modules/preambles/`, alors que l'arborescence montre aussi `modules/orchestrator/preamble.ts`. Clarifier la source de vérité.
- Le Dockerfile expose seulement `8787`, ce qui est correct si MCP reste interne, mais il faut préciser que le serveur MCP écoute quand même sur `127.0.0.1:8788` dans le container.
- La route REST listée `GET /orchestrators/:id/sessions/:sid/log` en Phase 4 ne correspond pas à l'API surface finale `GET /sessions/:id/log`. Choisir une seule convention.
- Le plan mentionne "React + Vite (CDN)" dans le schéma, mais la stack décrit une app Vite buildée. Remplacer "CDN" par "bundle statique servi par Express" si c'est l'intention.
- `uuid v7` doit être ajouté explicitement aux dépendances ou remplacé par `crypto.randomUUID()` si l'ordre temporel n'est pas nécessaire.

## 12. Tests à prévoir dans le plan

Le plan ne détaille pas la stratégie de tests. Il faut l'ajouter tôt.

Tests minimum :

- Unitaires : validation config, validation `cwd`, permissions lead-only, format des messages.
- Intégration : spawner + PTY fake process, logs, lifecycle kill.
- MCP : appels `tools/list` et `tools/call` contre le serveur réel.
- WebSocket : attach terminal, input, output, resize, auth refusée.
- Docker smoke test : `claude --version`, `/health`, création orchestrateur fake ou dry-run.

Raison : sans fake PTY/Claude, les tests seront lents et fragiles. Prévoir une interface `AgentProcess` permettra de tester sans lancer Claude.

## 13. Recommandation globale

Le plan est solide sur la vision produit et l'isolation multi-instance. Les corrections prioritaires sont :

1. valider les hypothèses Claude Code/MCP avant d'implémenter,
2. ajouter une mailbox au lieu de dépendre uniquement de `stdin`,
3. préciser lifecycle, auth WS et limites opérationnelles,
4. corriger les exemples Docker pour binder sur localhost,
5. ajouter une stratégie de tests avec processus Claude fake.

Ces changements gardent le MVP simple, mais évitent que l'architecture dépende de comportements implicites ou fragiles.
