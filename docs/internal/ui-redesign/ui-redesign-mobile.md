# UI Redesign — Intégration du prototype Mobile (parité complète)

> **Statut (2026-06-28) : IMPLÉMENTÉ & déployé.** Jalon 1 (aiguillage +
> monitoring + supervision) et Jalon 2 (control-plane + polish) livrés sur la
> branche `feat/ui-mobile-jalon-1` (commits `15990b9`, `95b96da`) et déployés
> sur `swarm-os-test`. Architecture clé : `controller/SwarmController` lifte le
> `useEvents` unique + l'état partagé au-dessus des deux shells ; `App.tsx`
> aiguille via `hooks/useShellMode` (`pointer:coarse && max-width:820px` +
> override `swarm-os.shell-mode`). MapView/Terminal/Composer/ConfirmModal/
> ConsoleOverlay/dialogs/SettingsDrawer réutilisés tels quels. Reste optionnel :
> tweaks client (showIntra/showPulses), vérif PWA, et le **test device réel**
> (single-WS à chaud, echo PTY clavier tactile). Vérifié : tsc + build + 311
> tests web (0 régression).

Plan d'intégration de la **variante mobile** (`prototypes/mobile/` +
`prototypes/Swarm OS Mobile.html`) dans le code React de `packages/web/`.
Pendant desktop de `docs/internal/ui-redesign/ui-redesign-desktop.md`, qui avait laissé le mobile
explicitement **hors scope** (« Phase E … activée plus tard via un breakpoint »,
§intro). Ce document acte la reprise de cette Phase E.

**Statut :** prototype existant, **zéro intégration** dans le code livré (v0.1.0
est desktop-only). Décision produit actée : viser la **parité complète**
desktop↔mobile, **console PTY interactive (writer) incluse**. Effort réel
estimé : **L+** (plusieurs blocs net-new absents du prototype).

---

## 0. Genèse — audit de faisabilité (corrigé après 2 revues adversariales)

Un premier audit concluait « ~85 % couvert, l'écart est UX pas données ». Deux
revues adversariales (parité desktop + exactitude des claims) l'ont **réfuté** :
ce chiffre mesure le mauvais écart.

| Question | Réponse |
|---|---|
| Le backend couvre-t-il ce que le **prototype** affiche ? | ~85 % ✅ (mais c'est un proto read-only) |
| Le prototype couvre-t-il la **surface opérateur desktop** ? | **~40 %** — c'est le vrai chantier |

Le prototype est un **sous-ensemble lossy** du desktop : chaque feature mobile a
un équivalent desktop plus riche ; l'inverse est faux pour ~13 surfaces, dont
**9 opérateur-critiques absentes du proto ET de l'audit initial** :

| Surface opérateur absente du proto | Source desktop | Criticité |
|---|---|---|
| **Auth / X-Auth-Token** (saisie token, `authState`, auto-open drawer) | `SettingsDrawer.tsx:129-159`, `DesktopShell.tsx:212-247`, `api/client.ts:236-244` | 🔴 sans token = UI vide |
| **Waiting / intervention** (toast « session waiting → open ») | `useEvents.ts:236-259`, `Toasts.tsx:42-64`, `DesktopShell.tsx:595-643` | 🔴 raison d'être supervision |
| **Create orchestrator** (form ~372 lignes) | `NewOrchestratorDialog.tsx`, `TopBar.tsx:148` | 🔴 action day-1 |
| **Broadcast-to-all-leads** (clic hub) | `MapView.tsx:308-317`, `BroadcastModal.tsx` | 🔴 hub mobile décoratif |
| **Config tab** (model/effort/perm/cwd/exit-reason) | `RightPanel.tsx:433-440`, `ConfigTab.tsx` | 🟠 |
| **Recently ended** (drilldown teams terminées) | `LeftPanel.tsx:177-206` | 🟠 |
| **Confirm modals** (destructif) | `ConfirmModal.tsx`, `RightPanel.tsx:460-471` | 🟠 |
| **Roles CRUD / schedule / Discord / IDE** | `RolesPage.tsx`, `RoleDialog.tsx`, `IdeOverlay.tsx` | 🟡 routes mortes sur mobile |
| **Composer audience+mode** (agent/team × pty/mailbox) | `Composer.tsx:45-122` | 🟠 proto = cible unique + réponse canned |

### Corrections factuelles vs premier audit
- `<meta viewport>` est **déjà présent** (`index.html:5`) — seul `matchMedia` au boot manque.
- Les chips palette/backdrop ont **déjà la bonne cardinalité** (6 accent + 3 bgTint, `AppearanceSection.tsx:17-30`) ; le vrai trou est le **desync** de `instanceLabel/darkMode/fontSize/density`.
- Spawn-worker / edit-config sont **désactivés même sur desktop** (`canSpawn=false`/`canSave=false` ; `POST .../workers` et `PATCH /orchestrators/:id` n'existent pas).
- Le modèle « réponse 1:1 » du composer mobile est **non-constructible** : aucune API DM/reply ; seulement broadcast-team ou input-PTY.

---

## 1. Principe directeur — réutiliser, ne pas réécrire

Le mobile rebranche les **mêmes** hooks, libs, transport et endpoints que le
desktop. On supprime les `setInterval`/données mock du prototype. On conserve sa
couche visuelle (shell iOS, bottom-sheets, dock).

**Réutiliser tel quel** (vérifiés purs, sans couplage desktop) :
- Hooks (`packages/web/src/hooks/`) : `useOrchestrators`, `useSession`, `useEvents`, `useGlobalMessageStats`, `useRoles`, `useInstanceSettings`.
- Libs : `lib/mapTeams.ts` (transform orbite — ⚠️ ajuster la constante de rayon pour le portrait 390 px), `lib/roleShape.ts`, `components/desktop/pulses.ts`, `lib/mailBubble.ts`, `lib/loadPercent.ts`.
- Transport : `api/client.ts` (endpoints + token + ws-ticket), `components/Terminal.tsx` (PTY writer/reader).
- Référence canonique de dispatch : `DesktopShell.tsx` (handleAction, handleToastOpen, broadcast).

**Porter** (présentation proto → composants prod) :
`prototypes/mobile/{mobile-shell,mobile-sheets,mobile-app,map,ios-frame}.jsx`
→ `packages/web/src/components/mobile/`.

---

## 2. Point de montage

`App.tsx:68` monte `<DesktopShell>`. Ajouter une bascule :

```tsx
const isMobile = useMatchMedia('(max-width: 768px)'); // boot + resize
return isMobile ? <MobileShell …/> : <DesktopShell …/>;
```

**Contraintes non négociables :**
- **Mutuelle exclusion** : un seul shell monté → un seul `useEvents()` (anti-doublon WS, commit `584d9ec`). MobileShell doit re-câbler **toute** la surface callbacks (`waiting`, `onMailboxMessage`→pulses, `onSessionCreated`, `onOrchestratorCreated`, cf. `useEvents.ts:82-89`), pas juste « réutiliser le hook ».
- **Honorer le contrat de routing** : `App.tsx:68-90` passe `routeOrchestratorId` + `onOpenOrchestrator/onOpenRoles/onOpenIde/onCloseRightPanel` et les hash-routes `#/orchestrators/:id`, `#/roles`, `#/ide`. MobileShell ouvre la bonne sheet depuis l'URL **et** produit l'URL (deep links + back/forward).
- `<meta viewport>` déjà présent — ne rien y toucher.

---

## 3. Slices d'implémentation (parité complète)

### Slice 0 — Fondations (bloquant)
- `useMatchMedia` + bascule exclusive MobileShell/DesktopShell.
- **Surface auth mobile** : porter la section AUTHENTICATION de `SettingsDrawer.tsx:129-159` + `authState`/`probeAuth` (`DesktopShell.tsx:212-247`). Sans saisie token = **écran vide** sur téléphone neuf (localStorage vierge ; les ws-tickets sont des REST authentifiés → carte/console inaccessibles).
- Re-câblage complet `useEvents` + honneur des hash-routes.

### Slice 1 — Monitoring honnête (read-only, vraies données)
- HealthStrip + Map + StatsSheet branchés à `useOrchestrators` / `useGlobalMessageStats` / `mapTeams`+`pulses`+`roleShape`.
- **Remplacer tous les mocks** : `window.SPARK_DATA`/`AGG_HISTORY`/bus cards figés → `/metrics/messages` (`global[60]`, `per_orchestrator[8]` keyé UUID) et `/metrics/bus` **404-safe** (`useBusHealth`, `LeftPanel.tsx:298-319`).
- **Taxonomie 9 états** (pas 3) : rendre `bad/FAILED`, `waiting`, `starting`, `paused`, `failed`, `interrupted`, `idle` (réf. `StatusBadge.tsx`, `TopBar.tsx:99-112`).
- Section **Recently ended** (`LeftPanel.tsx:177-206`).
- Cellule LOAD = `—` via `loadPercent.ts` (ne jamais inventer un nombre).

### Slice 2 — Supervision / intervention
- **Waiting → action** : toasts « SESSION WAITING → OPEN » depuis `useEvents().waiting` ; tap = pré-sélection session + sync route + dismiss (réf. `Toasts.tsx:42-64`, `DesktopShell.tsx:595-643`). Cœur de l'app mobile.
- **Actions routées correctement** (le proto applique tout uniformément — faux) :
  - worker → `/sessions/:id/{stop,pause,resume,restart}`.
  - lead → **interdit** sur `/sessions/*` (409 `LEAD_NOT_STOPPABLE/RESTARTABLE`, `orchestrator/index.ts:736-747,832-839`) ; lead lifecycle = `destroyOrchestrator` (KILL) + `restartOrchestrator`.
  - « REACTIVATE » team morte → `POST /orchestrators/:id/restart` (fresh-start-in-place ; le resume tue le lead en SSH — cf. `spawner/index.ts:485-558` + note runbook).
  - désactiver pause-lead (footgun : gèle la team).
- **Confirm modals** sur destructif (`ConfirmModal.tsx`).
- **Console PTY writer** : monter `Terminal.tsx` dans la bottom-sheet (writer/reader, ticket, resize) ; mode plein écran (réf. `ConsoleOverlay.tsx`). Risque UX clavier tactile assumé.
- **Composer** : porter `Composer.tsx` (audience agent/team × mode pty/mailbox) — abandonner le modèle « réponse canned 1:1 » du proto. MESSAGES tab = mailbox peek + WS via `mailBubble.ts`.

### Slice 3 — Control plane (net-new lourd)
- **Create-team** : porter `NewOrchestratorDialog.tsx` (~372 lignes) en sheet.
- **Broadcast hub** : hub central cliquable → `BroadcastModal` (`MapView.tsx:308-317`, `broadcastToOrchestrator`).
- **Config tab** (`ConfigTab.tsx`) + **Roles CRUD** (`RolesPage.tsx`/`RoleDialog.tsx`) + écrans `#/roles`, `#/ide`.
- ⚠️ **Spawn-worker / Edit-config** : désactivés même sur desktop (endpoints absents). Miroiter en **preview-disabled** ; activation réelle = chantier backend séparé, hors de ce plan.

### Slice 4 — Polish
- **Settings sync complet** : `accent`, `bgTint`, **+ `instanceLabel`, `darkMode`, `fontSize`, `density`** (`useInstanceSettings`) pour éviter le desync.
- Tweaks `showPulses`/`showIntra` (client-only), gestes carte (réconcilier pinch/pan proto avec le pan/zoom de `MapView`), PWA/manifest si désiré.

---

## 4. Fichiers

**Modifier**
- `packages/web/src/App.tsx` — bascule + passage des props/routes à MobileShell.

**Créer**
- `packages/web/src/components/mobile/` — MobileShell + sheets (portés de `prototypes/mobile/`).
- `packages/web/src/hooks/useMatchMedia.ts`.

**Réutiliser sans modifier**
- `packages/web/src/hooks/*`, `lib/{mapTeams,roleShape,mailBubble,loadPercent}.ts`, `components/desktop/pulses.ts`, `components/Terminal.tsx`, `api/client.ts`.

**Référence à reproduire**
- `components/desktop/{DesktopShell,RightPanel,LeftPanel,Composer,Toasts}.tsx`, `SettingsDrawer.tsx`, `NewOrchestratorDialog.tsx`, `RolesPage.tsx`, `BroadcastModal.tsx`.

---

## 5. Vérification

- **Bascule + auth** : `npm run dev` (`packages/web`), DevTools < 768 px → MobileShell monte / DesktopShell démonte (un seul WS dans Network) ; localStorage vidé → surface de saisie token (pas d'écran vide) ; back/forward et `#/orchestrators/:id` ouvrent la bonne sheet.
- **Monitoring** : team live → HealthStrip/Map/Stats sur vraies données ; `failed/waiting/paused/idle` rendus distinctement ; bus cards en `—` si `/metrics/bus` 404.
- **Supervision** : session `waiting` → toast actionnable ; STOP worker = 200 ; STOP lead via `/sessions/*` bloqué/redirigé vers `restartOrchestrator` ; KILL demande confirm.
- **Console PTY** : attache writer à un worker, frappe → echo ; 2e client = reader.
- **Control plane** : create-team depuis le téléphone démarre une team réelle ; broadcast hub atteint tous les leads ; spawn/edit affichés disabled.
- **Tests** : `npm test` (`packages/web`) ; ajouter tests MobileShell (bascule, single-WS, routing).
- **Live / 24-7** : `docker build -t swarm-os:latest .` + `docker compose -f docker-compose.test.yml up -d`, valider en largeur mobile via Tailscale.
