# swarm-os vs Hermes Agent — comparatif des features

> Établi le 2026-07-26 à partir du code/docs de ce repo (branche
> `feat/multi-provider-agents`) et de la doc publique de Hermes Agent
> (Nous Research, v0.6.0). Les détails Hermes viennent du site officiel et du
> README GitHub, pas d'une lecture du code.
>
> **Mise à jour 2026-08-02** (master `a680300`) : swarm-os a comblé trois des
> écarts majeurs identifiés ci-dessous, tous **livrés et déployés** — (1) une
> **mémoire longue partagée** façon Obsidian (graphe markdown + index FTS5,
> commune à tout le déploiement), (2) un **tableau de tâches Kanban** durable
> par équipe (SQLite, dépendances, audit, reprise après crash), et (3) des
> **garde-fous d'approbation humaine** (human-in-the-loop) pour les équipes
> non-bypass. Les lignes concernées sont annotées **« ✅ ajouté »** ci-dessous.

---

## 1. Positionnement

| | swarm-os | Hermes Agent |
|---|---|---|
| **Nature** | Console d'orchestration d'**équipes de CLI de code** (Claude Code & co) en PTY réels | **Agent personnel auto-améliorant** + framework, orienté assistant généraliste |
| **Unité de base** | Une instance = un projet ; Spawner → N orchestrateurs (1 lead + N workers) | Un agent avec mémoire persistante, qui spawne des subagents à la demande |
| **Licence** | Propriétaire (tous droits réservés) | MIT, open source |
| **Cible** | Single-user, un opérateur, supervision mobile | Individu → cloud managé (Hermes Cloud) |

---

## 2. Orchestration multi-agents

| Feature | swarm-os | Hermes Agent |
|---|---|---|
| Modèle d'équipe | 1 lead + N workers, persistant, nommé, redémarrable | Orchestrateur → workers éphémères par décomposition de tâche |
| Spawn par l'agent | `team.spawn_worker` / `kill_worker` / `kill_all_workers` (lead only) | Spawn de subagents avec contexte filtré |
| Communication | Mailbox in-memory + signal PTY, via MCP HTTP (`team.send_message`, `read_inbox`, `broadcast`) | Message passing typé, pas de mémoire partagée |
| Worker ↔ worker | Oui, direct (sans passer par le lead) | Non documenté (passe par l'orchestrateur) |
| Cross-équipe | `swarm.list_teams` / `send_to_lead` / `broadcast_to_leads` (lead only) | Pas d'équivalent multi-team |
| Coordination d'état | ✅ **ajouté** — **Kanban SQLite par équipe** (`board.*` MCP) : cartes, assignee = `session.id`, dépendances (DAG), journal d'audit append-only, reprise après crash (cartes orphelines re-flaggées au boot), auto-carte au spawn de worker, janitor TTL, page web Kanban (lecture seule + suppression), vue cross-équipe lead. *Auparavant : mailbox + état SQLite des sessions seulement.* | **Kanban SQLite** (cartes, assignee, dépendances, audit log, reprise après crash) |
| Sous-équipes imbriquées | Non (roadmap « petits-enfants ») | Hiérarchique par décomposition |
| Parallélisme | N workers par équipe, N équipes par instance | Concurrency limits configurables, resource-aware scheduling |

---

## 3. Agents & modèles

| Feature | swarm-os | Hermes Agent |
|---|---|---|
| Runtime agent | **CLI réels en PTY** : `claude`, `codex`, `gemini`, `opencode` (multi-provider mergé sur master) | Boucle d'agent maison appelant des LLM |
| Backends LLM | Ceux du CLI (auth CLI héritée de l'hôte) | 200–300+ : Nous Portal, OpenRouter, OpenAI, Anthropic, + locaux (Ollama, LM Studio, vLLM, SGLang, llama.cpp), switch `/model` |
| Modèle par agent | Oui (`model`, `effort`, `permissionMode` par rôle/équipe/worker) | Oui (profils d'agent par modèle) |
| Outils | MCP `team.*`/`swarm.*` + tous les outils natifs du CLI + outils de plugins | 40+ outils intégrés + client MCP |
| Mémoire longue | ✅ **ajouté** — **mémoire partagée façon Obsidian**, commune à tout le déploiement (toutes les équipes) : vault markdown = vérité + index SQLite/FTS5, `[[wikilinks]]` → graphe, **relations typées** (champs Dataview inline), **recherche texte / sémantique / hybride** (embeddings pluggables, fallback local), outils `memory.*` (consultée+maintenue par tous les agents, directive dans le préambule), **page web graphe**. *Auparavant : aucune côté plateforme, déléguée au CLI.* | **Mémoire 3 niveaux persistante**, profils Honcho, recherche FTS5 des sessions |
| Auto-amélioration | Aucune | Learning loop, création autonome de skills, GEPA, pipeline RL Atropos |
| Skills / marketplace | Non (rôles + préambules à la place) | Skills `agentskills.io` + marketplace communautaire |

---

## 4. Interfaces & supervision

| Feature | swarm-os | Hermes Agent |
|---|---|---|
| UI | SPA React + **xterm.js : attache à n'importe quelle session**, PWA mobile | Dashboard web (plugin Kanban) |
| Terminal humain | Oui, intervention live dans le PTY de l'agent | CLI/TUI pour l'utilisateur, pas d'attache à un subagent |
| IDE intégré | **VS Code web** in-container (`code serve-web`) | Non |
| Messagerie | Webhook **Discord** (`session.waiting` / `orchestrator.ended` / `session.exit_anomaly`), deep-links | **Gateway multi-plateformes** : Telegram, Discord, Slack, WhatsApp, Signal, email |
| Voix | Non (un plugin d'exemple `discord-agent` fait STT/TTS OpenAI) | Voice mode natif (STT/TTS), memos |
| Accès distant | Bind 127.0.0.1 + Tailscale | Gateways + Hermes Cloud |
| Approbation humaine | ✅ **ajouté** — **garde-fous d'approbation (human-in-the-loop)** pour les équipes non-bypass : détection d'un prompt de permission → file persistée → notification (**toast web + page `#/approvals` + embed Discord**) → décision par **boutons web / reply Discord / réaction Discord ✅ approuver · ♾️ approuver+ne plus demander · ❌ refuser / REST / console** → frappe PTY → l'agent repart. Réglages par rôle (modes qui arment, toggle Discord), janitor TTL. Claude aujourd'hui (les autres providers sont bypass-only). *Le mode `bypassPermissions` reste inchangé, jamais interrompu.* | Gates d'approbation (Telegram), **Tirith** (permissions, garde-fous) |

---

## 5. Plateforme & exploitation

| Feature | swarm-os | Hermes Agent |
|---|---|---|
| Extensibilité | **Plugins ESM in-process**, hot enable/disable, install depuis dossier/tgz/npm/git, capabilities accordées par l'opérateur, panels UI iframe, routes HTTP, connectors, `host-exec` SSH, isolation de crash (5 crashes/60 s → quarantaine) | Skills + serveurs MCP + plugins dashboard |
| Templates | **Rôles** = presets versionnés (prompt lead, préambules, modèle, nb workers, connectors) | Profils d'agent |
| Scheduling | **Crons de première classe** (écran dédié, N par rôle, pause/tir manuel, historique des runs), in-process, action `message` livrée dans la mailbox du lead ou action `script` qui décide du réveil | Cron natif, définition en langage naturel, jobs chaînés |
| Persistance | SQLite + **backup à chaud** (online backup API) sur `/data`, recovery au boot | SQLite (Kanban, sessions) |
| Déploiement | Docker obligatoire, image GHCR, `install.sh`, 1 container par projet | Installeurs one-line (Linux/macOS/WSL2/Windows/Termux), Docker, Python 3.11+/uv, cloud |
| Mise à jour | **Update 1-clic** : détection GitHub Release, **préavis aux équipes ≥ 120 s**, réécriture de `SWARM_OS_IMAGE`, vérif `/health`, rollback auto | `/update` (self-host) |
| Isolation | **Container uniquement** — tout tourne en `bypassPermissions` | Backends terminal isolés : local, Docker, SSH, Singularity, Modal, Daytona ; exécution Python sandboxée |
| Auth | Token `X-Auth-Token` + `HOOK_TOKEN` séparé, MCP port intra-container | Tirith (permissions/approbations) |
| Multi-tenant | Non (roadmap) | Cloud managé |

---

## 6. Lecture rapide

- **swarm-os gagne** sur : supervision opérationnelle (terminal attaché, VS Code,
  mobile), équipes persistantes nommées avec coordination cross-équipe, cycle de
  vie industriel (update avec préavis aux agents en cours, backup à chaud,
  recovery), et le fait de piloter de **vrais CLI de code** avec leurs quotas et
  leurs outils.
- **Écarts comblés (2026-08)** — ne sont plus des avantages exclusifs de Hermes :
  **mémoire longue** (désormais partagée, façon Obsidian, commune au déploiement),
  **coordination d'état durable** (Kanban SQLite par équipe), et **garde-fous
  d'approbation humaine**. swarm-os a aussi rattrapé l'**agnosticisme modèle**
  côté CLI (claude/codex/gemini/opencode mergés sur master).
- **Hermes garde l'avantage** sur : auto-amélioration/apprentissage (learning
  loop, skills auto-générés, GEPA/RL), amplitude des backends LLM (300+ dont
  locaux, là où swarm-os dépend des providers des CLI), surface de contact
  utilisateur (6 messageries + voix native), sandboxing pluggable
  (Docker/SSH/Modal/Daytona…), et l'écosystème ouvert (MIT, marketplace de skills).
- **Complémentaires plus que concurrents** : swarm-os n'a pas encore d'agent
  auto-améliorant ni de skills auto-générés (il délègue au CLI) ; Hermes n'a ni
  console d'attache PTY, ni multi-équipes, ni gestion de flotte containerisée par
  projet.

**Réserve** : la doc multi-agent de Hermes ne précise ni l'architecture mémoire
des subagents, ni leur sandboxing, ni l'API au-delà du spawn.

---

## 7. À faire — pistes d'évolution swarm-os

Une de ces pistes est désormais **livrée** ; l'autre reste à faire.

1. ✅ **livré (2026-08-02, déployé en test)** — **Graphify en complémentarité avec la
   mémoire Obsidian.** Couche de **graphe de connaissances structurel** façon *Graphify*
   intégrée à swarm-os : indexation automatique en arrière-plan (watcher + janitor) du
   code de 1re partie du workspace et des plugins (hors deps/`node_modules`), **désactivée
   si aucun code détecté** ; sous-graphes compressés servis à la demande (~70–90 % de
   tokens en moins) via les outils MCP `codegraph.list/search/explain/path` (à interroger
   avant de greper — directive ajoutée au préambule lead+worker) ; **intégration à la
   mémoire Obsidian (Option A)** = fiche `reference` auto-gérée par scope + hub
   `[[wikilinks]]` bidirectionnels ; **page web dédiée `#/graph`** (vue force-directed
   bornée + auto-focus du hub sur gros scope + bouton « graphe complet » servant le
   `graph.html` natif de Graphify). Répartition des rôles confirmée : Obsidian = couche
   wiki lisible (le « quoi / pourquoi »), Graphify = carte structurelle du code/infra
   (le « où / comment »).

2. **Bibliothèque de skills importable.** Offrir un **catalogue de skills**
   activables par rôle/équipe, **importables depuis des sources connues** (ex.
   marketplaces type `agentskills.io`, dépôts git publics) **ou ajoutés par
   l'utilisateur**. Comble le gap « Skills / marketplace : Non » (§3) et rapproche
   de l'écosystème de skills de Hermes, en s'appuyant sur le système de **plugins
   ESM + rôles/préambules** déjà en place (un skill = préambule/outillage versionné,
   partageable et activable à la demande).

---

## Sources

- <https://hermes-agent.ai/features>
- <https://hermes-agent.ai/features/multi-agent>
- <https://github.com/NousResearch/hermes-agent>
- Graphify + Obsidian (pattern mémoire pour agents de code) :
  <https://github.com/lucasrosati/claude-code-memory-setup>,
  <https://www.charlieautomates.com/blog/claude-code-knowledge-graph-graphify-obsidian/>
- Ce repo : `README.md`, `plan.md` (§10, §12, §16), `packages/server/src/modules/`
