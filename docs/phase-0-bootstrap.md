# Phase 0 — Bootstrap

## 1. Livrable

Squelette du monorepo `swarm-os` : workspaces pnpm, un package serveur
(Express 5 + `ws`) qui expose `/health` et un endpoint WebSocket placeholder
`/ws/events`, un package web (Vite 6 + React 19 + Tailwind 4) qui consomme
les deux pour valider le pipeline end-to-end. Outillage qualité (ESLint
flat-config + Prettier) en place. Aucune logique métier (Spawner,
Orchestrator, MCP, PTY, SQLite, auth) — voir plan.md §6 pour le découpage
des phases suivantes.

## 2. Layout du dépôt

```
swarm-os/
├── plan.md                       # spécification, source de vérité
├── package.json                  # workspaces root, scripts dev/build/lint/format
├── pnpm-workspace.yaml           # déclare packages/* + allowBuilds.esbuild
├── pnpm-lock.yaml
├── eslint.config.js              # flat config, scopes node/browser séparés
├── .prettierrc                   # singleQuote, trailingComma all, printWidth 100
├── .prettierignore
├── .gitignore                    # node_modules, dist, .env*, /data, /tmp/swarm-os
├── archives/                     # itérations antérieures du plan (hors scope code)
├── docs/
│   └── phase-0-bootstrap.md      # ce document
└── packages/
    ├── server/
    │   ├── package.json          # express, ws, tsx (dev), tsc (build)
    │   ├── tsconfig.json         # NodeNext, strict, noUncheckedIndexedAccess
    │   └── src/index.ts          # /health + WS /ws/events (echo + hello)
    └── web/
        ├── package.json          # react 19, vite 6, tailwind 4, plugin-react
        ├── vite.config.ts        # bind 127.0.0.1:5173 + proxy vers serveur
        ├── tsconfig.json         # references app + node
        ├── tsconfig.app.json
        ├── tsconfig.node.json
        ├── index.html
        └── src/
            ├── main.tsx          # bootstrap React, StrictMode
            ├── App.tsx           # affiche /health JSON + flux WS
            └── index.css         # @import 'tailwindcss'
```

La structure cible complète (modules `spawner/`, `orchestrator/`, `mcp/`,
`db/`, etc.) est décrite dans plan.md §7 — elle se remplira aux phases
1 à 5.

## 3. Lancer en local

Prérequis : Node ≥ 22 (testé en v22.22.2), pnpm 11.

```
pnpm install                      # installe toutes les workspaces
pnpm dev                          # lance server + web en parallèle (concurrently)
pnpm build                        # tsc côté server, tsc -b && vite build côté web
pnpm lint                         # eslint .
pnpm format                       # prettier --write .
```

Scripts par package (utiles pour debug ciblé) :

```
pnpm --filter server dev          # tsx watch src/index.ts
pnpm --filter server build        # tsc → packages/server/dist
pnpm --filter server start        # node dist/index.js (post-build)
pnpm --filter web dev             # vite dev server
pnpm --filter web build           # bundle statique
pnpm --filter web preview         # sert le bundle buildé
```

URLs attendues :

- Serveur HTTP : `http://127.0.0.1:8787/health`
- Serveur WS  : `ws://127.0.0.1:8787/ws/events`
- Web (Vite)  : `http://127.0.0.1:5173`

Variables d'env reconnues côté serveur :

- `SWARM_OS_PORT` (défaut `8787`)
- `SWARM_OS_HOST` (défaut `127.0.0.1`)

## 4. Checklist de vérification

- `curl http://127.0.0.1:8787/health` retourne `{"status":"ok","uptime":<n>}`.
- `pnpm dev` puis ouvrir `http://127.0.0.1:5173` : la page affiche le JSON
  `/health` (proxy Vite OK) et le statut WS passe à `open`.
- La liste WS contient au minimum le `hello` envoyé par le serveur à la
  connexion ; le `ping` envoyé par le client est echo back (preuve que
  `/ws/events` fait bien round-trip).
- Le fond de page est sombre (`bg-slate-950`) → Tailwind 4 est compilé
  par `@tailwindcss/vite`.
- `pnpm lint` passe sans erreur (scopes node + browser correctement
  appliqués selon le chemin du fichier).
- `pnpm build` produit `packages/server/dist/index.js` et un bundle dans
  `packages/web/dist/`.

## 5. Stack effective vs plan

| Couche               | Choix Phase 0           | Conforme plan §4 ?                         |
|----------------------|-------------------------|--------------------------------------------|
| Runtime serveur      | Node 22 (`engines >=22`)| Divergence — plan §4 cible Node 24         |
| Package manager      | pnpm 11                 | Oui                                        |
| HTTP framework       | Express 5               | Oui                                        |
| WebSocket            | `ws`                    | Oui                                        |
| Frontend             | React 19 + Vite 6       | Oui                                        |
| Styling              | Tailwind 4 (plugin Vite)| Oui                                        |
| TypeScript           | 5.7, strict + NodeNext  | Implicite plan (cohérent)                  |
| Lint/Format          | ESLint 9 flat + Prettier 3 | Oui (« alignés Fyrel »)                 |
| Dev runner serveur   | `tsx watch`             | Ajout non listé — choix pragmatique        |
| Orchestration scripts| `concurrently`          | Ajout non listé — pratique pour `pnpm dev` |
| pnpm workspace       | `allowBuilds: { esbuild: true }` | Ajout — autorise le post-install d'esbuild (dépendance Vite) sans approve interactif |

Divergences à arbitrer plus tard :

- **Node 22 vs 24** : aligner soit sur la base image `node:24-bookworm-slim`
  (plan §4 / §13), soit assumer un downgrade si pas de feature 24-only
  utilisée. À trancher avant Phase 5 (containerisation).
- `tsx` et `concurrently` sont des dépendances dev pures ; à conserver
  ou remplacer par `node --watch` + scripts Make si on veut réduire la
  surface.

## 6. Limites volontaires de Phase 0

Aucun de ces éléments n'est livré ici, ils relèvent des phases
ultérieures (cf. plan.md §6) :

- Pas de **Spawner** ni d'**Orchestrator** — Phase 1.
- Pas de **`node-pty`**, pas de session Claude Code spawnée — Phase 1.
- Pas de **serveur MCP** ni d'outils `team-comms` — Phase 2/3.
- Pas de **mailbox**, pas de signal PTY — Phase 3.
- Pas de **SQLite / `better-sqlite3` / `/data`** — Phase 4.
- Pas de **notifications Discord** ni de hook `Notification` — Phase 4.
- Pas d'**auth** (token HTTP, ticket WS) — Phase 1+ (selon besoin).
- Pas de **Dockerfile** ni de `docker-compose` — Phase 5.
- Pas de **`CLAUDE_CONFIG_DIR`** ni d'init `.claude-runtime` — Phase 5.
- Pas de **README** racine ni de docs deployment/multi-project —
  Phase 6.
- Le script `scripts/verify-claude-code.ts` (Phase 0 bis) n'est pas
  inclus ici, c'est un livrable séparé.

## 7. Dette et points à reprendre

- **Node 22 vs 24** (sévérité : moyenne) — divergence avec plan §4.
  Décider avant Phase 5, sinon mismatch image Docker / dev local.
- **Auth WebSocket absente** (sévérité : moyenne) — `/ws/events` accepte
  toute connexion. À fermer avec le ticket usage unique décrit
  plan §9 / §14 dès que le serveur expose autre chose qu'un echo.
- **Bind `127.0.0.1` à auditer** quand Docker arrive (sévérité : haute
  à ce moment-là) — dans le container il faudra écouter `0.0.0.0` mais
  publier le port uniquement sur `127.0.0.1` côté host (plan §13/§14).
  Le défaut actuel (`SWARM_OS_HOST=127.0.0.1`) est correct hors
  container.
- **`allowBuilds: { esbuild: true }`** (sévérité : faible) — à étendre
  explicitement aux autres natives builds dès qu'on ajoute
  `better-sqlite3` et `node-pty` (Phases 1 et 4).
- **`pnpm-lock.yaml` versionné** (sévérité : info) — vérifier que la
  CI installera bien en `--frozen-lockfile` quand elle existera
  (Phase 7).
- **Pas de tests** (sévérité : info) — couvert formellement Phase 7 ;
  rien à factoriser maintenant.
