# Phase 0 bis — Spike Claude Code

## 1. Livrable

Cette phase livre un script de validation, `scripts/verify-claude-code.ts`,
exécutable via `pnpm verify:claude`. Il sonde 8 hypothèses sur le binaire
`claude` (CLI Claude Code) et émet un rapport `scripts/verify-claude-code.report.md`
qui recense, pour chaque hypothèse, la commande exacte testée, le code de
sortie observé, et les implications pour les phases suivantes du plan.
Le script est non-destructif : il n'écrit jamais dans le `~/.claude` ni le
`~/.claude.json` de l'hôte ; toute fixture temporaire est créée puis
supprimée sous `/tmp/swarm-os-spike/`.

## 2. Pourquoi un spike

Les Phases 1 à 5 (cf. plan.md §6) reposent sur un ensemble d'hypothèses
non-triviales sur la CLI Claude Code : nom exact du modèle, syntaxe du
flag de permission, schéma JSON attendu par `--mcp-config`, mécanisme de
hook `Notification`, statut RW de `~/.claude`. Chacune de ces hypothèses
est cheap à tester en isolation (un sous-processus, un flag, un exit code)
et coûteuse à découvrir fausse au milieu de Phase 3 (où le `spawn_worker`
construit déjà la ligne de commande complète d'un worker). Un spike
dédié, daté et reproductible, fixe le contrat et sert de référence
unique en cas de désaccord ultérieur entre une phase doc et la CLI réelle.

## 3. Hypothèses testées

Le script définit 8 vérifications. Voir `scripts/verify-claude-code.report.md`
pour la sortie complète et les commandes exactes.

- **H1** — `claude --version` répond et expose une version reconnaissable.
- **H2** — `--model claude-opus-4-7` (nom complet dashed) est accepté, en plus des alias `opus`/`sonnet`.
- **H3** — `--permission-mode bypassPermissions` est documenté dans `--help` et accepté en mode `--print`.
- **H4** — `--mcp-config <file>` consomme un JSON `{ "mcpServers": { ... } }`, et fail-fast sur fichier manquant ou JSON malformé.
- **H5** — La CLI expose `--effort <level>` (et non `--max-thinking-tokens`) pour piloter le budget de raisonnement.
- **H6** — Le hook `Notification` est câblable via `--settings <file-or-json>` (ou `CLAUDE_CONFIG_DIR/settings.json`) avec une entrée `hooks.Notification`.
- **H7** — `~/.claude` est un répertoire mixte RW (sessions, cache, history, credentials), donc non mountable en RO.
- **H8** — `CLAUDE_CONFIG_DIR=<dir>` redirige bien la CLI vers un répertoire de config alternatif et permet l'isolation par session.

## 4. Synthèse des résultats

| H#  | Hypothèse                                          | Statut    | Impact plan                                                                 |
|-----|----------------------------------------------------|-----------|------------------------------------------------------------------------------|
| H1  | `claude --version`                                 | CONFIRMED | CLI 2.1.142 disponible, prérequis runtime OK.                                |
| H2  | `--model claude-opus-4-7`                          | CONFIRMED | Nom canonique pour plan §17 confirmé ; aucune correction nécessaire.         |
| H3  | `--permission-mode bypassPermissions`              | CONFIRMED | Mode par défaut plan §17 validé ; legacy `--dangerously-skip-permissions` toléré mais déprécié. |
| H4  | `--mcp-config <file>` schéma                       | CONFIRMED | Schéma JSON figé pour Phase 2 (cf. §6 ci-dessous).                          |
| H5  | `--effort` vs `--max-thinking-tokens`              | CONFIRMED | **Correction plan §17** : `--effort` est le flag réel ; voir §8.            |
| H6  | Hook `Notification` via `settings.json`            | PARTIAL   | Schéma + flag confirmés ; déclenchement réel à valider en Phase 4.          |
| H7  | `~/.claude` RW vs RO                               | CONFIRMED | Plan §13 (copie boot vers `/data/.claude-runtime/`) confirmé obligatoire.   |
| H8  | `CLAUDE_CONFIG_DIR` redirige le config dir         | CONFIRMED | Isolation per-session via `CLAUDE_CONFIG_DIR=…/sessions/{id}/` validée.     |

## 5. Mapping des flags CLI obligatoires pour les phases en aval

Cette table est extraite du bloc `Implications` du rapport généré et fait
foi : si une phase doc diverge, c'est la phase doc qu'il faut corriger.

| Domaine            | Flag / variable                                                          | Source |
|--------------------|--------------------------------------------------------------------------|--------|
| Modèle             | `--model claude-opus-4-7`                                                | H2     |
| Permission         | `--permission-mode bypassPermissions`                                    | H3     |
| Budget raisonnement| `--effort low\|medium\|high\|xhigh\|max` (**PAS `--max-thinking-tokens`**) | H5     |
| MCP                | `--mcp-config <file>` avec `{ "mcpServers": { ... } }`                   | H4     |
| Config par session | `CLAUDE_CONFIG_DIR=<dir>` + `<dir>/settings.json` contenant `hooks.Notification` | H6, H8 |
| `~/.claude` host   | RW obligatoire — copie boot-time vers `/data/.claude-runtime/` (plan §13) | H7     |

Schéma JSON `--mcp-config` figé pour Phase 2 :

```json
{
  "mcpServers": {
    "<name>": {
      "type": "http" | "sse",
      "url": "https://…",
      "headers": { "<k>": "<v>" }
    },
    "<other>": {
      "command": "node",
      "args": ["./server.js"],
      "env": { "FOO": "bar" }
    }
  }
}
```

Schéma `settings.json` figé pour le hook `Notification` (Phase 4) :

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "<shell qui POSTe le payload stdin>" }
        ]
      }
    ]
  }
}
```

Le hook reçoit sur stdin un JSON
`{ session_id, transcript_path, cwd, hook_event_name: "Notification", message }`.

## 6. Re-rejouer le spike

Commande unique :

```
pnpm verify:claude
```

Le script est **idempotent** : chaque exécution recrée à neuf
`/tmp/swarm-os-spike/` (fixtures MCP, `settings.json` témoin, alt config
dir pour H8) puis le supprime entièrement en fin de run. Aucun fichier
sous `~/.claude` ni `~/.claude.json` n'est lu en écriture, et le rapport
`scripts/verify-claude-code.report.md` est réécrit intégralement à chaque
run avec un timestamp ISO en en-tête.

Si la CLI n'est pas authentifiée (`claude /login` jamais lancé), les
checks H2, H3, H6 reportent `UNVERIFIED` ou `PARTIAL` plutôt que `REFUTED`,
distinguant un échec de flag d'un échec d'auth.

## 7. Ce qui reste UNVERIFIED ou PARTIAL

- **H6 — Hook `Notification`** : `PARTIAL`. Le spike a confirmé que
  `--settings <file-or-json>` est un flag documenté, qu'il est parsé sans
  erreur avec un `settings.json` contenant `hooks.Notification`, et que
  le schéma de payload est conforme à la doc Anthropic. **Il n'a pas
  validé le déclenchement réel du webhook** : `--print` ne génère pas
  d'événement `Notification`. Phase 4 (notifs Discord + persistance, cf.
  plan.md §6) doit ajouter un test d'intégration qui :
  1. lance une session `claude` réelle (pas `--print`),
  2. provoque une condition de notification (idle, attention requise),
  3. vérifie qu'une requête HTTP atterrit bien sur
     `http://127.0.0.1:8787/hooks/notification` avec le header
     `Authorization: Bearer <HOOK_TOKEN>` et le payload attendu.

Aucune autre hypothèse n'est `UNVERIFIED` ou `REFUTED`.

## 8. Corrections de plan que ce spike autorise

- **plan.md §17, ligne « Notion d'`effort` reportée »** : peut être levée
  en v0.1. Le flag canonique est `--effort <low|medium|high|xhigh|max>`
  (validé H5). `--max-thinking-tokens N` est silencieusement ignoré par la
  CLI (exit 0, aucun effet documenté) — toute mention dans le plan ou le
  code doit être remplacée par `--effort`.
- **plan.md §13** : la stratégie de copie boot-time `~/.claude` →
  `/data/.claude-runtime/` n'est plus optionnelle, c'est une obligation
  (validée H7). Tout mount RO direct de `~/.claude` casse Claude Code
  dès la première écriture de session, cache ou history.
- **plan.md §10 et §6 (Phase 2)** : le contrat MCP que Phase 2 doit
  implémenter est figé par H4 — top-level
  `{ "mcpServers": { [name]: { type: 'http'|'sse', url, headers? } | { command, args?, env? } } }`,
  fail-fast sur fichier manquant ou JSON malformé. Ce contrat est la
  référence pour la génération du `mcp.json` par session.
- **plan.md §6 (Phase 3)** : `team.spawn_worker` doit construire son
  `argv` claude avec `--model`, `--permission-mode`, `--mcp-config` et
  `--effort` (jamais `--max-thinking-tokens`).
