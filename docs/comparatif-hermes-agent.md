# swarm-os vs Hermes Agent — comparatif des features

> Établi le 2026-07-26 à partir du code/docs de ce repo (branche
> `feat/multi-provider-agents`) et de la doc publique de Hermes Agent
> (Nous Research, v0.6.0). Les détails Hermes viennent du site officiel et du
> README GitHub, pas d'une lecture du code.

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
| Coordination d'état | Mailbox volatile + état SQLite des sessions | **Kanban SQLite** (cartes, assignee, dépendances, audit log, reprise après crash) |
| Sous-équipes imbriquées | Non (roadmap « petits-enfants ») | Hiérarchique par décomposition |
| Parallélisme | N workers par équipe, N équipes par instance | Concurrency limits configurables, resource-aware scheduling |

---

## 3. Agents & modèles

| Feature | swarm-os | Hermes Agent |
|---|---|---|
| Runtime agent | **CLI réels en PTY** : `claude`, + `codex`, `gemini`, `opencode` (branche en cours) | Boucle d'agent maison appelant des LLM |
| Backends LLM | Ceux du CLI (auth CLI héritée de l'hôte) | 200–300+ : Nous Portal, OpenRouter, OpenAI, Anthropic, + locaux (Ollama, LM Studio, vLLM, SGLang, llama.cpp), switch `/model` |
| Modèle par agent | Oui (`model`, `effort`, `permissionMode` par rôle/équipe/worker) | Oui (profils d'agent par modèle) |
| Outils | MCP `team.*`/`swarm.*` + tous les outils natifs du CLI + outils de plugins | 40+ outils intégrés + client MCP |
| Mémoire longue | Aucune côté plateforme (déléguée au CLI : `CLAUDE.md`, mémoire Claude Code) | **Mémoire 3 niveaux persistante**, profils Honcho, recherche FTS5 des sessions |
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
| Approbation humaine | Interventions manuelles + hook Notification | Gates d'approbation (Telegram), **Tirith** (permissions, garde-fous) |

---

## 5. Plateforme & exploitation

| Feature | swarm-os | Hermes Agent |
|---|---|---|
| Extensibilité | **Plugins ESM in-process**, hot enable/disable, install depuis dossier/tgz/npm/git, capabilities accordées par l'opérateur, panels UI iframe, routes HTTP, connectors, `host-exec` SSH, isolation de crash (5 crashes/60 s → quarantaine) | Skills + serveurs MCP + plugins dashboard |
| Templates | **Rôles** = presets versionnés (prompt lead, préambules, modèle, nb workers, connectors) | Profils d'agent |
| Scheduling | Cron par rôle, in-process, livré dans la mailbox du lead | Cron natif, définition en langage naturel, jobs chaînés |
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
- **Hermes gagne** sur : mémoire/apprentissage persistant, agnosticisme modèle
  (300+ backends dont locaux), surface de contact utilisateur (6 messageries +
  voix), coordination d'état durable (Kanban), sandboxing pluggable, et
  l'écosystème ouvert (MIT, skills marketplace).
- **Complémentaires plus que concurrents** : swarm-os n'a ni mémoire longue ni
  skills auto-générés (il délègue au CLI) ; Hermes n'a ni console d'attache PTY,
  ni multi-équipes, ni gestion de flotte containerisée par projet.

**Réserve** : la doc multi-agent de Hermes ne précise ni l'architecture mémoire
des subagents, ni leur sandboxing, ni l'API au-delà du spawn.

---

## Sources

- <https://hermes-agent.ai/features>
- <https://hermes-agent.ai/features/multi-agent>
- <https://github.com/NousResearch/hermes-agent>
- Ce repo : `README.md`, `plan.md` (§10, §12, §16), `packages/server/src/modules/`
