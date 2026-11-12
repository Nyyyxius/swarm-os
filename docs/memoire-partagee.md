# Mémoire partagée SwarmOS — graphe de connaissances intégré ("Oxydien")

> Recherche & analyse — 2026-07-31. Établi à partir d'une cartographie du code
> de ce repo (`packages/server`, `packages/web`, `packages/plugin-sdk`) et du
> comparatif `docs/internal/analyses/comparatif-hermes-agent.md`.
>
> **But** : combler le seul vrai manque « plateforme » de SwarmOS face à Hermes
> Agent — la **mémoire longue partagée** — par un graphe de connaissances façon
> Obsidian, **consultable en web directement dans SwarmOS (sans app externe)** et
> que **tous les agents** lisent, enrichissent et maintiennent.

---

## 1. Le gap à combler

`docs/internal/analyses/comparatif-hermes-agent.md` (§3) : mémoire longue = **« Aucune côté
plateforme (déléguée au CLI : `CLAUDE.md`, mémoire Claude Code) »** vs Hermes
= « Mémoire 3 niveaux persistante, profils Honcho, recherche FTS5 ».

Vérifié dans le code : **aucune** mémoire/knowledge/graph/vector/FTS côté serveur.
Le schéma SQLite (`packages/server/src/modules/db/schema.sql`) n'a que
`orchestrators`, `roles`, `sessions`, `mailbox_messages`, `instance_settings`.
La seule « mémoire » existante est déléguée au CLI (`CLAUDE.md`, `GEMINI.md`) —
donc **par-agent, non partagée, invisible côté plateforme**.

## 2. Vision cible

- **Un graphe de connaissances unique, global à l'instance** : nœuds = notes
  (markdown + frontmatter), arêtes = liens `[[wikilink]]` (+ relations typées
  optionnelles).
- **Partagé par tous les agents** (leads + workers, toutes équipes) : chacun peut
  **chercher, lire, écrire, mettre à jour, lier**. C'est le différenciateur : un
  cerveau commun, pas un `CLAUDE.md` par projet.
- **Consultable en web dans SwarmOS** : une page « Memory » affiche le graphe et
  les notes, **sans l'app externe** qu'Obsidian impose pour sa vue graphe.
- **Format = celui que les agents connaissent déjà.** La mémoire de Claude Code
  (fichiers markdown + frontmatter `name/description/type/metadata` + liens
  `[[name]]` + index `MEMORY.md`) est déjà un vault Obsidian-compatible. On la
  **promeut du niveau agent au niveau plateforme** → les agents savent produire
  de bonnes notes sans quasi rien apprendre.

## 3. Décision d'architecture : **core**, pas plugin

Le graphe doit être global cross-équipe, toujours actif, et surtout **auto-consulté
au démarrage** par chaque agent. Or :

- Les outils MCP d'un plugin **sont** exposés à tous les agents (via l'unique
  serveur `team-comms`), mais leur annonce au préambule est générique
  (`buildPluginToolsSection`, `preamble.ts:221`) — elle **ne peut pas** injecter
  une directive « consulte la mémoire au démarrage ».
- Seul le **préambule core** (`default-lead.md` / `default-worker.md`) délivre
  proprement cette directive (durable au `/clear` via `--append-system-prompt`).

→ **Core**. (Un plugin `memory` reste un bon moyen de *spiker* vite les outils
sans toucher au serveur — voir Phase 0.)

## 4. Modèle de stockage : fichiers source-de-vérité + index SQLite (hybride)

Trois options ont été pesées :

| Option | Pour | Contre |
|---|---|---|
| A. SQLite seul (nœuds/arêtes + FTS5) | transactionnel, requêtable, colle au DAO | perd la nature « vault » (pas ouvrable dans Obsidian, pas git-friendly) |
| B. Vault markdown seul | Obsidian-compatible, git/backup-friendly, format déjà connu des agents | recherche/graphe = re-parse à chaque fois, concurrence délicate |
| **C. Hybride (retenu)** | fichiers = vérité (vault Obsidian-compatible, sur `/data` sauvegardé à chaud) **+** miroir SQLite (`memory_nodes`, `memory_edges`, `memory_fts`) dérivé pour recherche/graphe/web | un `MemoryStore` qui écrit fichier **et** index de façon atomique |

**Retenu : C.** Fidèle à la référence Obsidian (le vault reste des fichiers,
portable, versionnable, dans le `/data` déjà couvert par le backup à chaud), tout
en offrant la **recherche FTS5** (comme Hermes) et un rendu de graphe O(1) pour la
vue web. Toute écriture passe par `MemoryStore.write()` qui écrit
`memory/<name>.md` puis upsert `memory_nodes` + `memory_fts` et re-dérive les
arêtes depuis les `[[links]]`.

### Schéma de note (frontmatter — repris de la mémoire Claude Code)

```markdown
---
name: <slug-kebab-case>          # = nom de fichier, identité du nœud
description: <une ligne>          # sert au rappel (recherche)
type: user|feedback|project|reference|entity|decision
metadata: { ... }
created_by: <session/agent>      # provenance
team: <orchestrator_id>          # provenance
created_at / updated_at
version: <int>                   # concurrence optimiste
---

Le fait, avec des liens [[autre-note]] vers les nœuds voisins.
```

Arêtes dérivées des `[[name]]` (non typées par défaut) ; relations typées
optionnelles via `memory.link({from,to,relation})`.

## 5. Outils MCP (core) — exposés à chaque agent

À écrire dans un `registerMemoryTools()` (calqué sur `registerTeamCommsTools`,
`mcp/tools.ts`), monté dans `mcp/server.ts` **juste après** `registerTeamCommsTools`
(ligne ~229). Réutilise `ok()` / `requireLead()` / `logCall()`.

| Outil | Rôle | Accès |
|---|---|---|
| `memory.search({query,type?,limit?})` | recherche FTS5 classée (titre, extrait, score, liens) — **voie de rappel principale** | tous |
| `memory.read({name})` | note complète + voisins (liens entrants/sortants) | tous |
| `memory.write({name,description,type,body,links?})` | créer/mettre à jour (upsert, append vs replace), re-dérive les arêtes | tous |
| `memory.link({from,to,relation?})` | ajouter une arête typée | tous |
| `memory.list({type?,prefix?})` / `memory.neighbors({name,depth?})` | parcourir / marcher le graphe | tous |
| `memory.delete({name})` | supprimer | **lead** (`requireLead`) |

Écriture ouverte à tous (le but : que tous « incrémentent, mettent à jour,
maintiennent »), destructif réservé aux leads. Concurrence gérée par `version` /
`updated_at` (verrou optimiste) pour éviter les pertes quand N agents écrivent.

## 6. Injection préambule (la pièce qui impose le core)

Ajouter une section « Mémoire partagée » à `default-lead.md` et
`default-worker.md` :

- **Au démarrage** : `memory.search` sur le contexte pertinent avant d'agir ;
  traiter les résultats comme du savoir de fond (comme le rappel mémoire de
  Claude Code).
- **Après une tâche significative** : écrire/mettre à jour des notes (faits,
  décisions, entités), les lier.
- Ajouter les noms d'outils à `TEAM_TOOL_LOGICAL_NAMES` (`preamble.ts:72`) pour le
  renommage codex/gemini/opencode, **et** mettre à jour `preamble.test.ts` (il
  vérifie la synchro avec `registerTeamCommsTools`).

C'est exactement le mécanisme de la mémoire Claude Code — patron éprouvé.

## 7. Vue web « Memory » (le graphe intégré, sans app externe)

- **Route** : ajouter `{kind:'memory'}` + `#/memory` à l'union `Route` et à
  `parseHash`/`setHashRoute` dans `packages/web/src/App.tsx` ; rendre
  `<MemoryPage open onClose/>` en overlay (patron `RolesPage.tsx`).
- **Nav** : bouton `MEMORY` `.tb-action` dans `components/desktop/TopBar.tsx`
  (+ passthrough `onOpenMemory` via `controller/SwarmController.tsx`).
- **Données** : hook `useMemoryNotes()` (copie du shape poll de
  `useOrchestrators`) + méthodes/types dans `api/client.ts` ; live via nouveaux
  events `memory.*` sur le bus (`events.ts`) diffusés par l'`EventsHub` existant
  sur `/ws/events` (aucun nouveau WS).
- **Canvas graphe** : réutiliser le shell SVG **pan/zoom** de
  `components/desktop/MapView.tsx` + `Node`/`NodeShape` + `curveBetween` (arêtes
  Bézier) + les tokens `desktop-theme.css` ; **remplacer** le layout hub-and-spoke
  `layoutTeams.ts` par un **layout force-directed** (seule vraie nouvelle dép :
  `d3-force`). Clic nœud → note (markdown) dans le panneau latéral ; édition
  inline → REST → même `MemoryStore` → visible par les agents.
- Maths (parse wikilinks, layout) dans `packages/web/src/lib/` avec tests Vitest
  colocalisés (convention maison).

## 8. REST + temps réel (backend web)

- `packages/server/src/http/routes/memory.ts` → `createMemoryRouter(memoryStore)`,
  monté avec les autres routers **authentifiés** dans `http/main.ts` (~ligne 298).
  Endpoints : `GET /api/memory` (liste), `GET /api/memory/:name`, `GET
  /api/memory/graph`, `GET /api/memory/search?q=`, `PUT /api/memory/:name`.
- Events `memory.node_created` / `memory.edge_created` / `memory.node_updated`
  ajoutés à `events.ts` (union ouverte → non-cassant), émis par le store.

## 9. Points d'insertion (récap chirurgical)

| Pièce | Fichier(s) |
|---|---|
| Tables + store | `packages/server/src/modules/memory/store.ts` (possède ses tables, façon `plugins/store.ts`) ; instancié dans `src/index.ts` (~l.136), threadé dans `spawner` + `McpServer` |
| Outils MCP | `registerMemoryTools()` près de `modules/mcp/tools.ts`, appelé dans `modules/mcp/server.ts` (~l.229) |
| Directive préambule | `modules/preambles/default-lead.md` + `default-worker.md` ; `TEAM_TOOL_LOGICAL_NAMES` (`orchestrator/preamble.ts:72`) ; `preamble.test.ts` |
| REST | `http/routes/memory.ts`, monté dans `http/main.ts` |
| Temps réel | kinds dans `events.ts`, émis via `eventBus` ; servis par `/ws/events` |
| Page web | `packages/web/src/App.tsx` (route), `components/desktop/TopBar.tsx` (nav), `components/MemoryPage.tsx`, `hooks/useMemoryNotes.ts`, `api/client.ts`, canvas dérivé de `components/desktop/MapView.tsx` (+ `d3-force`) |

## 10. Plan d'intégration incrémental ("tranquillement")

- **Phase 0 — spike (optionnel, jetable)** : plugin `memory` (`api.storage.defineTable`
  + `api.mcp.registerTool`) pour valider l'ergonomie des outils avec de vrais
  agents, **zéro** changement serveur.
- **Phase 1 — stockage + outils MCP (backend)** : `MemoryStore` (fichiers=vérité +
  index SQLite + FTS5), `registerMemoryTools` (search/read/write/link/list),
  tests. → les agents lisent/écrivent déjà la mémoire partagée via MCP, **avant
  toute UI**.
- **Phase 2 — préambule** : section « Mémoire partagée » + `TEAM_TOOL_LOGICAL_NAMES`
  + test. → chaque agent consulte et maintient la mémoire **automatiquement**.
- **Phase 3 — REST + events** : `routes/memory.ts` + kinds `memory.*`. → données
  atteignables par le web, en direct.
- **Phase 4 — page web Memory** : overlay + graphe force-directed (`d3-force`)
  réutilisant le shell `MapView` + éditeur de note. → **le graphe façon Obsidian
  dans SwarmOS, sans app externe**.
- **Phase 5 — plus tard** : relations typées, recherche sémantique/vecteurs
  (sqlite-vec), ACL/curation par note, export git du vault, **rôle « entretien
  mémoire »** (worker planifié qui dédoublonne/élague/relie — équivalent léger du
  learning loop de Hermes).

## 11. Risques & décisions à confirmer

- **Concurrence** : N agents qui écrivent → verrou optimiste (`version`) + mode
  append pour les journaux. Intégré dès la Phase 1.
- **Confiance/curation** : une mémoire partagée peut être polluée par un agent
  confus → provenance (`created_by`/`team`), suppression lead-only, vue de revue,
  flag `verified` (Phase 5).
- **Portée « tous les agents »** : global à l'instance (interprétation des mots de
  l'utilisateur) vs par-projet. Hypothèse : **global**. À confirmer.
- **Nom « Oxydien »** : interprété comme « façon Obsidian » (graphe markdown +
  wikilinks, vue graphe nécessitant l'app externe). À confirmer.
</content>
</invoke>
