# swarm-os documentation

Start with the [README](../README.md) for what swarm-os is and the one-command
install. This page indexes the rest. Documents marked *(FR)* are in French;
they are being translated to English over time.

## Install and operate

- [deploy/README.md](deploy/README.md): overview of the deployment docs and
  what the install kit contains.
- [deploy/install.en.md](deploy/install.en.md) / [deploy/install.fr.md](deploy/install.fr.md):
  installation, configuration reference, remote access, updates and
  troubleshooting.
- [deploy/usage.en.md](deploy/usage.en.md) / [deploy/usage.fr.md](deploy/usage.fr.md):
  day-to-day operation of a running instance.

## Agents

- [providers.md](providers.md): running agents on `claude`, `codex`, `gemini`
  and `opencode`, with each CLI's contract, capabilities and host
  prerequisites.
- [model-aliases.md](model-aliases.md) *(FR)*: model family aliases, so new
  agents follow the latest Opus / Sonnet / Fable model.
- [auto-compact.md](auto-compact.md) *(FR)*: context-threshold auto-compact
  per role and resuming work after a compaction.
- [outils-par-role.md](outils-par-role.md) *(FR)*: per-role tool lists and
  on-demand tool loading (ToolSearch).

## Features

- [builtin-features.md](builtin-features.md) *(FR)*: switching the built-in
  features (code graph, monitoring, approvals, board, memory, IDE) on and off
  at runtime.
- [crons-agents.md](crons-agents.md) *(FR)*: agent crons, the `#/crons`
  screen and script crons (example in
  [examples/crons/](../examples/crons/README.md)).
- [monitoring-agents.md](monitoring-agents.md) *(FR)*: context, messages,
  inbox, cost and per-call usage monitoring.
- [memoire-partagee.md](memoire-partagee.md) *(FR)*: the shared
  knowledge-graph memory used by all agents.
- [tableau-de-taches.md](tableau-de-taches.md) *(FR)*: the durable per-team
  task board (Kanban).
- [garde-fous-approbation.md](garde-fous-approbation.md) *(FR)*: the
  human-in-the-loop approval queue.
- [graphify-integration.md](graphify-integration.md) *(FR)*: the code
  knowledge graph built with Graphify.

The last four were written as design proposals before the code; the code may
differ in details.

## Extending swarm-os

- [plugins.md](plugins.md): writing, installing and managing plugins, the
  capability model and the plugin API.
- Example plugins live in [examples/plugins/](../examples/plugins/) and an
  example skill in [examples/skills/](../examples/skills/).

## Architecture and contributing

- [composants.md](composants.md) *(FR)*: the main components and the stack
  each one uses.
- [CONTRIBUTING.md](../CONTRIBUTING.md): dev setup, tests, architecture map,
  conventions and the release procedure.
- [CHANGELOG.md](../CHANGELOG.md): changes per version.
- [SECURITY.md](../SECURITY.md): how to report a vulnerability.

## Design history

[internal/](internal/README.md) holds the original specification, the phase
reports, and the plans and analyses behind past features. They are historical
working notes, mostly in French, and are not user documentation.
