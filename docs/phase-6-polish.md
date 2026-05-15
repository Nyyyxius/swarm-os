# Phase 6 — Polish

## 1. Livrable

Phase 6 ferme la half-day "polish" listée au plan §6 et absorbe les carry-overs
des reviews précédentes. Six axes, tous strictement périmètre polish :

1. **Token init UX** : log de boot explicite (path + length, jamais la valeur)
   + panneau de settings qui détecte 401 et guide l'opérateur vers la commande
   `docker exec <container> cat /data/token`. Génération automatique au
   premier boot était déjà en place (Phase 1 pour `SWARM_OS_TOKEN`, Phase 4
   pour `HOOK_TOKEN`).
2. **`~/.claude.json` lift** (Phase 5 known issue) : `claude-init` lift désormais
   le fichier sibling (`<sourceDir>.json` ou
   `SWARM_OS_CLAUDE_JSON_SOURCE`) vers `<runtimeDir>/.claude.json` (mode 0600,
   cache via mtime). Les compose examples documentent le mount optionnel
   `~/.claude.json:/claude-source.json:ro`. Sans ce lift, claude affichait
   `configuration file not found` + theme-picker interactif au premier spawn.
3. **PWA manifest + service worker** : `manifest.webmanifest`, icônes
   (192/512/512-maskable/180-apple), `sw.js` ≤ 50 lignes (cache du shell
   statique, network-only sur `/orchestrators`, `/sessions`, `/health`,
   `/info`, `/ws*`, `/hooks/*`, `/api/*`). Registration depuis `main.tsx`
   guardée par `import.meta.env.PROD` (HMR dev intouché).
4. **README** agent-readable à la racine (119 lignes, sous le cap 120), plain
   Markdown lisible avec `cat`/`grep` : quickstart Docker single, dev local,
   layout du repo, badges verify (15 + 23 + 25 = 63), cross-refs vers
   `plan.md` / `docs/` / `archives/`. Pas de section License (TODO en
   commentaire).
5. **Carry-overs fixés** :
   - `Session.stop()` early-return aussi sur `interrupted` (sinon le statut
     `interrupted` posé par `recoverFromCrash()` pouvait être écrasé).
   - `uncaughtException` → log fatal + `shutdown()` + `process.exit(1)`
     (avec guard timer 5s pour ne jamais hang). Cas typique : `EADDRINUSE`
     async sur `http.listen`.
   - `NewOrchestratorDialog` affiche un warning amber quand
     `permissionMode === 'bypassPermissions'` (défaut), citant l'isolation
     container comme prerequis.

## 2. Module map

```
packages/server/src/
├── index.ts                       # +boot.tokens log, uncaughtException fatal
├── config.ts                      # +claudeJsonSource (SWARM_OS_CLAUDE_JSON_SOURCE)
├── runtime/claude-init.ts         # +liftClaudeJson + claudeJsonSource opt
└── modules/orchestrator/
    ├── session.ts                 # +'.claude.json' in SHARED_ENTRIES, stop() early-return on interrupted

packages/web/
├── index.html                     # +manifest link, theme-color, apple-touch
├── public/                        # NEW
│   ├── manifest.webmanifest
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── icon-maskable-512.png
│   ├── apple-touch-icon.png
│   └── sw.js
├── tsconfig.app.json              # +types: vite/client
└── src/
    ├── main.tsx                   # +SW registration (PROD only)
    ├── App.tsx                    # +probeAuth, auto-open settings on 401, hint UX
    └── components/
        └── NewOrchestratorDialog.tsx  # +bypassPermissions amber warning

scripts/
└── gen-icons.ts                   # NEW — hand-rolled PNG encoder (no deps)

examples/
├── docker-compose.single.yml      # +optional /claude-source.json mount
└── docker-compose.multi.yml       # +optional /claude-source.json mount × 2

eslint.config.js                   # +service-worker globals for public/sw.js
README.md                          # NEW
```

## 3. PWA — manifest, icônes, install mobile

`packages/web/public/manifest.webmanifest` (plan §6 Phase 6) déclare :

- `name`/`short_name` = `swarm-os`, `display: standalone`, `start_url`/`scope = /`
- `theme_color` / `background_color` = `#0f172a` (slate-950, cohérent header UI)
- `icons` : `icon-192.png` + `icon-512.png` en `purpose: any`,
  `icon-maskable-512.png` en `purpose: maskable` (zone safe Android adaptive),
  `apple-touch-icon.png` (180×180, référencé via `<link>` dans `index.html`)

`packages/web/index.html` ajoute `<link rel="manifest">`,
`<meta name="theme-color">`, `<link rel="apple-touch-icon">`. Ces trois lignes
sont le minimum pour que Chrome/Safari proposent "Add to Home Screen" sur
mobile.

**Install path mobile** : ouvrir l'instance via Tailscale
(`https://swarm.tail-xyz.ts.net:8787`) → menu navigateur → "Add to Home
Screen" / "Install app". Le SW ne sert pas l'install per se ; il fournit le
shell offline + accélère les ouvertures à froid (cache-first sur `/assets/*`).
Sans SW (dev mode), l'install reste possible mais le shell repart du réseau
à chaque ouverture.

Registration dans `packages/web/src/main.tsx`, gardée par
`import.meta.env.PROD` : en dev (`pnpm dev`), Vite sert les modules `/src/*`
avec HMR — un SW collerait ces réponses au cache et briserait le hot reload.

## 4. Service worker scope

**Cached** (cache-first ou SWR sur `/`) :

- `/`, `/index.html` (stale-while-revalidate via fetch→cache.put fallback)
- `/manifest.webmanifest`, `/icon-*.png`, `/apple-touch-icon.png`
- `/assets/*` (JS/CSS hashés Vite — content-addressed, cache forever safe)

**Never cached** (regex-matched dans `NEVER_CACHE` — pass-through réseau) :

- `/orchestrators*`, `/sessions*`, `/hooks/*`
- `/health`, `/info`, `/ws-ticket`
- `/ws/*` (WebSocket upgrades — un SW ne peut pas les proxifier de toute façon)
- `/api/*` (préfixe réservé — vide aujourd'hui, pré-bloqué)

Cache versioning via constante `CACHE = 'swarm-os-shell-v1'`. Bumper le suffixe
invalide tout après un breaking change shell ; le handler `activate` supprime
chaque cache name qui ne matche pas la version courante. La règle est sans
ambiguïté : **toute donnée authentifiée passe réseau, jamais SW**.

## 5. Static serving — `express.static` avant l'auth

`packages/server/src/http/main.ts` mount le bundle web via
`express.static(webRoot, { index: false })` **avant** le middleware
`X-Auth-Token`. Conséquences :

- `/`, `/index.html`, `/assets/*`, `/manifest.webmanifest`, `/sw.js`,
  `/icon-*.png`, `/apple-touch-icon.png` répondent **sans token** — sinon
  l'install PWA est impossible (le manifest se fetch avant tout contexte JS).
- Routes REST (`/orchestrators*`, `/sessions*`, `/ws-ticket`) restent gated
  `401` — middleware `auth` mounté juste après le static. `/health` et
  `/info` restent publics (mountés avant tout, plan §9).
- Headers : `Cache-Control: public, max-age=31536000, immutable` sur
  `/assets/*` (hash content-addressed) ; `max-age=0, must-revalidate` ailleurs.
- Fallback SPA : `app.get('/', sendFile(index.html))` pour ouvrir l'app sans
  token déjà saisi ; routing hash gère les deep-links `#/orchestrators/<id>`.

`findWebRoot()` essaie plusieurs candidats (Docker `/home/node/app/web/`,
monorepo `packages/web/dist/`). Si aucun n'existe (dev local), no-op silencieux
et l'opérateur attaque Vite directement sur `:5173`.

## 6. `~/.claude.json` lift

Resolution order in `liftClaudeJson()`:

1. `claudeJsonSource` (from env `SWARM_OS_CLAUDE_JSON_SOURCE`)
2. `<sourceDir>.json` (implicit sibling — works with the compose example
   mount `~/.claude.json:/claude-source.json:ro`)

If neither resolves to a regular file, the lift is a silent no-op (dev mode).
On success, copy to `<runtimeDir>/.claude.json` with mode 0600 and preserve
mtime so subsequent boots cache-hit (no spurious re-copies).

Per-session: `.claude.json` is added to the `SHARED_ENTRIES` list in
`Session._linkSharedClaudeState`. Each per-session config dir
`<runtimeDir>/sessions/<sid>/` therefore contains a symlink
`.claude.json -> <runtimeDir>/.claude.json`. Claude resolves
`CLAUDE_CONFIG_DIR/.claude.json` and finds the lifted state — no theme
picker, no "configuration file not found" warning.

## 7. Token init UX

Boot log on `event:'boot.tokens'` carries:

- `swarmTokenSource`: `'env'` (from `SWARM_OS_TOKEN`) or `'file'` (from
  `<dataDir>/token`)
- `swarmTokenPath`: path when `source === 'file'`, else null
- `swarmTokenLen`: length only — value never logged (pino redact also has
  this covered defence-in-depth)
- `hookTokenSource` / `hookTokenPath` / `hookTokenLen`: same for HOOK_TOKEN
- `hint`: a one-line operator hint with the docker exec command

Web UI: `App.tsx` calls `api.listOrchestrators()` on mount as an auth probe;
on 401 OR missing token, auto-opens the Settings panel and surfaces an
amber callout with the exact `docker exec` command to retrieve `/data/token`.

## 8. Carry-overs

- `Session.stop()` was `[exited|killed|failed].includes(status) → return`.
  Phase 6 adds `'interrupted'` to that set — `recoverFromCrash()` marks all
  non-terminal sessions as `interrupted` on boot, and a stale code path that
  calls `stop()` on those should be a no-op rather than re-arm a SIGTERM
  timer (which would also try to dereference `agent = null`).
- `uncaughtException` previously logged then continued running with a
  half-open server. Now: `rootLog.fatal({event:'uncaughtException',
  fatal:true,...})` → graceful `shutdown('uncaughtException')` → guarded
  `process.exit(1)`. Guard timer (5s, `unref`'d) ensures we don't hang on a
  wedged db/handle.
- `bypassPermissions` warning text in the NewOrchestratorDialog: "Safe
  inside the swarm-os container; do NOT use outside isolated environments."

## 9. Configuration deltas (plan §13)

| Var | Défaut | Notes |
|---|---|---|
| `SWARM_OS_CLAUDE_JSON_SOURCE` | (unset) | Explicit override for the `.claude.json` lift source. Optional — when unset, `<claudeSourceDir>.json` is tried. |

The token / hook-token env vars (`SWARM_OS_TOKEN`, `HOOK_TOKEN`) were already
listed in §13 ; their auto-init behaviour is unchanged (Phase 1 + Phase 4).

## 10. Validation

```sh
pnpm install
pnpm -r build         # incl. web — manifest + sw.js + icons land in dist/
pnpm lint             # 0 problems
pnpm --filter server verify:phase2   # 15/15
pnpm --filter server verify:phase3   # 23/23
pnpm --filter server verify:phase4   # 25/25
docker build -t swarm-os:phase6 .    # builds clean
```

For PWA verification, `pnpm --filter web preview` then open
`http://127.0.0.1:4173`; DevTools → Application → Manifest should show the
parsed `swarm-os` icon set; Service Workers should list `sw.js` as active.

Container smoke (post-build, plan §13) :

```sh
docker run -d --name swarm-smoke --init -p 127.0.0.1:8787:8787 \
  -v /tmp/swarm-os-smoke/data:/data swarm-os:phase6
# PWA assets unauth (no token header) :
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/            # 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/sw.js       # 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/manifest.webmanifest  # 200
# REST gated (no token) :
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/orchestrators # 401
docker rm -f swarm-smoke
```

## 11. Déviations du plan

- **Service worker = 1 fichier statique** dans `packages/web/public/sw.js`
  (pas de Workbox / VitePWA plugin). Le plan §7 mentionnait
  `packages/web/src/pwa/sw.ts` — on garde le fichier en `public/` car
  l'install URL doit être stable (`/sw.js`) et le SW lui-même n'a aucune
  dépendance bundlée. Plus simple, plus auditable, ≤ 50 lignes.
- **Icônes générées par script Node sans deps** (`scripts/gen-icons.ts`).
  Le plan suggérait `@resvg/resvg-js` — on évite la deps native pour quatre
  PNG flat. Reproducible : même script → mêmes bytes.
- **`tsconfig.app.json` ajoute `"types": ["vite/client"]`** pour le typage
  d'`import.meta.env.PROD`. Touchpoint minimal vs ambient `vite-env.d.ts`.
- **`uncaughtException` exit code = 1** (pas configurable). Cohérent avec
  les conventions Unix et `restart: unless-stopped` du compose.
- **`express.static` câblé en Phase 6** (plan §6 Phase 7 le rangeait avec
  les tests / smoke Docker). Sans ce câblage, l'install PWA est impossible
  (le manifest se fetch sans contexte JS donc sans token), donc l'artefact
  Phase 6 lui-même dépendait du static serving. On l'a wired ici plutôt
  que d'attendre Phase 7.
- **`/claude-source.json:ro` mount uncommented dans les deux compose
  examples**. Le code review a flaggé une **ambiguïté cosmétique** : le
  commentaire YAML dit "optional" mais la ligne n'est pas commentée.
  Décision : laisser uncommented — sans ce mount, premier spawn = theme
  picker interactif qui wedge le PTY. Coût d'un mount RO inutile = zéro ;
  coût de l'oublier = orchestrateur qui ne démarre pas. Le commentaire reste
  explicite pour que l'opérateur puisse retirer la ligne en connaissance.

## 12. Limitations restantes / known issues

- **Pas de GC** des `<runtimeDir>/sessions/<sid>/` à l'exit d'une session
  (Phase 5 known issue, toujours là). Orphan = `settings.json` + symlinks
  (~1 KiB) — pas dangereux, pas urgent.
- **PWA push notifications** : non implémentées. Le SW est shell-only.
  Discord webhook reste le canal push.
- **Phase 7 (Tests)** : suite unit/integration proprement dite. Les
  `verify:phase*` restent des harnesses spike-style — utiles, mais
  insuffisants pour une CI à terme.
