# Outils par rôle et chargement à la demande (v0.10.2)

Chaque appel d'un agent Claude Code renvoie au modèle la **définition de tous
ses outils**. Mesuré le 2026-09-26 sur l'instance `my-project` (claude 2.1.283) :

| Premier appel d'une session | Contexte |
|---|---|
| Sonnet, `ENABLE_TOOL_SEARCH=false` (v0.10.1 et avant) | 55,5 k tokens |
| Sonnet, chargement à la demande (ToolSearch) | 30,4 k |
| Sonnet, `--tools=Bash,Read` sans ToolSearch | 24,7 k |
| Sonnet, `--tools=Bash,Read,ToolSearch` | 16,1 k |
| Opus, `ENABLE_TOOL_SEARCH=false` → ToolSearch | 42,5 k → 18,1 k |

Ce socle est relu à **chaque** appel. La v0.10.2 agit sur deux leviers.

## 1. Chargement à la demande (ToolSearch)

Depuis le 2026-07-04, swarm-os posait `ENABLE_TOOL_SEARCH=false` sur toutes les
sessions claude. La raison : avec claude 2.1.201, Haiku ratait l'enchaînement
ToolSearch → appel et perdait team-comms.

Désormais `ENABLE_TOOL_SEARCH` n'est plus posé, sauf pour les modèles **haiku**,
qui gardent l'ancien comportement (outils en entier dans le contexte).

- Opus et Sonnet atteignent team-comms via ToolSearch. Vérifié : l'appel
  `team.whoami` aboutit.
- Surcharge pour toute l'instance, via `SWARM_OS_CLAUDE_TOOL_SEARCH` :
  - `off` : comportement d'avant la v0.10.2 pour tout le monde. C'est le levier
    de retour arrière, sans reconstruire l'image ; il suffit de redémarrer.
  - `on` : ToolSearch pour tout le monde, Haiku compris.
  - `auto` (valeur par défaut, ou variable absente) : la règle par modèle.

## 2. Listes d'outils par rôle

Quatre champs de rôle, modifiables dans la page Rôles (section OUTILS) ou par
l'API `POST` / `PATCH /roles`. `null`, ou un champ vide dans l'interface, veut
dire « tous les outils », comme avant.

| Champ | Portée | Mécanisme |
|---|---|---|
| `leadTools` | outils **intégrés** de la lead | `claude --tools=A,B,…` |
| `workerTools` | outils **intégrés** des workers | `claude --tools=A,B,…` |
| `leadMcpTools` | outils **team-comms** de la lead | filtrage côté serveur MCP |
| `workerMcpTools` | outils **team-comms** des workers | filtrage côté serveur MCP |

### Outils intégrés (`--tools`)

- La liste est **exacte**. Un outil absent disparaît du contexte : il n'est pas
  seulement refusé, sa définition n'est plus envoyée.
- `--tools` ne touche pas aux outils MCP.
- Quand le chargement à la demande est actif, swarm-os **ajoute `ToolSearch`
  d'office** à la liste. Sans lui, la CLI remet team-comms en entier dans le
  contexte (voir le tableau ci-dessus).
- La liste est lue au **lancement** de la session. Un nouveau worker l'applique
  aussitôt ; une lead l'applique à son prochain démarrage ou à sa reprise.
- Noms utiles : `Bash`, `Read`, `Edit`, `Write`, `WebFetch`, `WebSearch`,
  `TaskStop`, `Monitor`, `CronCreate`, `CronDelete`, `CronList`,
  `ScheduleWakeup`, `WaitForMcpServers`, `Agent`, `Skill`…

### Outils team-comms

- Le serveur MCP reconstruit son jeu d'outils à **chaque requête**, avec
  l'identité de la session qui appelle. Il n'enregistre donc que ce que cette
  session a le droit de voir.
- Les noms s'écrivent sous leur forme pointée : `team.send_message`,
  `memory.search`, `discord-agent.reply`. Les formes `team_send_message` et
  `mcp__team-comms__team_send_message` sont aussi acceptées.
- **Toujours gardés**, quelle que soit la liste : `team.whoami`, `team.list`,
  `team.send_message`, `team.read_inbox`, `team.context_compact`,
  `team.context_clear` (`MCP_CORE_TOOLS`).
- **Toujours masqués aux workers**, même sans liste : les outils refusés aux
  workers à chaque appel (`LEAD_ONLY_MCP_TOOLS` dans
  `modules/mcp/tool-filter.ts`), plus les outils de plugin déclarés `leadOnly`.
  Les outils réservés à la lead **en partie** restent visibles : `board.assign`
  (auto-assignation), `board.list` / `board.get` (hors lecture inter-équipes),
  `discord.send_message` (dans un fil).

### Validation

L'API répond 400 pour une liste vide, un élément qui n'est pas une chaîne, une
chaîne vide, ou un nom qui contient une virgule ou un espace. Pour revenir à
« tous », il faut envoyer `null`. En lecture, une colonne corrompue se lit
comme `null`, donc « tous les outils », jamais comme « aucun ».

### Stockage

Quatre colonnes additives, nullables et sans valeur par défaut :
`roles.lead_tools_json`, `worker_tools_json`, `lead_mcp_tools_json` et
`worker_mcp_tools_json`, qui contiennent des tableaux JSON. Une v0.10.1 relancée
sur cette base les ignore.
