# Step 20 — Command launcher (⌘K) : la topbar passe de 11 boutons à 2

> Lié à `04_topbar-data-binding.md` (dont la rangée de boutons devient obsolète)
> et à `11_settings-drawer.md` (section APPEARANCE, cible d'un des items).
> Source design : projet Claude Design `Swarm OS v2.html` + `v2/launcher.jsx`,
> re-synchronisé dans `prototypes/` (répertoire non versionné).
>
> Ce step **ne touche pas au serveur** : aucune route, aucun endpoint, aucun
> hook de données nouveau. C'est un remaniement du chrome desktop.

---

## 1. Objectif

`.topbar-right` avait accumulé **11 boutons** — NEW TEAM, ROLES, MEMORY, BOARD,
APPROVALS, CODE GRAPH, PLUGINS, SKILLS, IDE, UPDATE (conditionnel), cog — au
point qu'une media query masquait déjà tous les labels sous 1280px. Chaque
destination ajoutée rognait la `health-strip`, c'est-à-dire la seule zone de la
barre qui porte de l'information vivante.

Après ce step la barre ne porte plus que **`+ NEW TEAM`** et **`MENU`**. Les
destinations vivent dans un panneau filtrable, piloté au clavier (`⌘K` / `↑↓` /
`↵` / `esc`). Deux conséquences :

- la `health-strip` récupère la largeur, et les labels tiennent jusqu'à 720px ;
- ajouter une destination coûte **une ligne** dans `LAUNCHER_GROUPS`, plus un
  bouton de chrome.

---

## 2. Table des destinations

Source unique : `LAUNCHER_GROUPS` dans
`packages/web/src/components/desktop/CommandLauncher.tsx`. Le panneau émet un
`LauncherActionId` ; `TopBar.handlePick` le route sur le callback existant.

| id | groupe | handler TopBar | destination |
|---|---|---|---|
| `new-team` | CREATE | `onNewTeam` | `NewOrchestratorDialog` |
| `roles` | WORKSPACE | `onOpenRoles` | `#/roles` |
| `memory` | WORKSPACE | `onOpenMemory?.()` | `#/memory` |
| `board` | WORKSPACE | `onOpenBoard?.()` | `#/board` |
| `approvals` | WORKSPACE | `onOpenApprovals?.()` | `#/approvals` |
| `code-graph` | WORKSPACE | `onOpenGraph?.()` | `#/graph` |
| `skills` | WORKSPACE | `onOpenSkills?.()` | `#/skills` |
| `plugins` | WORKSPACE | `onOpenPlugins` | `#/plugins` |
| `ide` | WORKSPACE | `onOpenIde` | overlay IDE (`#/ide`) |
| `update` | SYSTEM *(conditionnel)* | `onOpenUpdates` | SETTINGS §SYSTEM UPDATE |
| `settings` | SYSTEM | `onOpenSettings` | SETTINGS |
| `appearance` | SYSTEM | `onOpenAppearance?.()` | SETTINGS §APPEARANCE |

**Aucune prop de `TopBar` n'a été supprimée** : les 9 handlers sont désormais
routés par `onPick` au lieu d'avoir un bouton chacun. `DesktopShell` ne change
que de deux lignes (`onOpenAppearance`, `menuBlocked`).

**Le badge chiffré du prototype n'est volontairement pas porté.** Il n'existe
aucune source honnête pour l'alimenter : `approvalToasts`
(`controller/SwarmController.tsx`) est la liste des notifications WS reçues
*depuis le chargement de la page* — elle repart de zéro à chaque rechargement,
et `dismissApproval` en retire une entrée sans résoudre le gate. Un opérateur
rechargeant l'onglet avec cinq approbations en attente aurait vu « rien à
faire ». `useApprovals` ne convient pas non plus : il est **par
orchestrateur** et poll toutes les 5 s.

À rebrancher le jour où le serveur expose un compteur de pending global. Le
CSS `.li-badge` n'est pas porté non plus, pour ne pas laisser de règle
orpheline ; il reste dans le prototype, qui est l'artefact de design.

---

## 3. Les quatre écarts assumés vis-à-vis du prototype

Décidés avec l'opérateur avant implémentation.

1. **`+ NEW TEAM` reste visible.** Le prototype le range dans le groupe CREATE
   du panneau. C'est l'action la plus fréquente de l'écran : elle garde son
   bouton, tout en restant listée dans le panneau (accent ambre, `N`).
2. **UPDATE = item conditionnel *plus* pastille sur MENU.** Le prototype ignore
   la feature (il est antérieur). Ne mettre l'item que dans le panneau aurait
   rendu la mise à jour invisible sans ouvrir le menu ; la pastille ambre sur
   MENU préserve le signal. `info.updateAvailable` vient du **même objet** que
   `info.version` peint dans le brand — jamais un render d'écart, ce que le
   test verrouille.
3. **APPEARANCE ouvre SETTINGS scrollé sur sa section.** Le prototype se
   contentait de faire tourner le backdrop. Ici l'apparence est une vraie
   section du drawer : on duplique littéralement le mécanisme `focusUpdates`
   (`appearanceFocus` → `openAppearance` → `<AppearanceSection focus>` →
   `scrollIntoView`), sans inventer de second patron.
4. **Desktop uniquement.** `MobileShell` / `.m-dock` gardent leur propre
   rangée et leur propre badge update : le mobile a son design de référence
   (`Swarm OS Mobile.html`), qui ne comporte pas ce panneau.

---

## 4. Garde ⌘K vs terminaux agents

Le prototype intercepte `(metaKey || ctrlKey) + k` inconditionnellement. Ici
c'est un piège : **`Ctrl+K` est un raccourci readline vivant** (kill-line) dans
les terminaux xterm montés par `RightPanel` via `components/Terminal.tsx`, et
l'événement remonte jusqu'à `window`.

`CommandLauncher.isTypingContext()` filtre donc `Ctrl+K` lorsque la cible est
un `input`, un `textarea`, un `[contenteditable]` ou un descendant de `.xterm`
(xterm pose cette classe sur le conteneur passé à `term.open()`). `⌘K` reste
inconditionnel : sur macOS, `Ctrl+K` n'est pas la convention d'ouverture.

**Limite connue et acceptée** : panneau ouvert avec le focus dans le champ de
recherche, `Ctrl+K` ne le referme pas (la garde s'applique). `Escape` et `⌘K`
le font.

---

## 5. Détails d'implémentation

- **Montage depuis la `TopBar`**, pas depuis `DesktopShell` : la barre possède
  déjà l'intégralité des callbacks `onOpen*`. Le panneau est un sibling du
  `<header>` dans un fragment.
- **Arbitrage des couches** — le point le plus délicat du step, parce que le
  panneau est la première surface de l'app qu'un raccourci clavier peut
  invoquer *par-dessus une autre*. Trois règles :
  - **Portail vers `document.body`, obligatoire.** `.app` est en
    `position: fixed`, ce qui crée un **contexte d'empilement** de niveau 0 :
    tout z-index posé à l'intérieur y est enfermé. Or les overlays de route
    (`.roles-overlay`, `.mem-overlay`, `.board-overlay`, `.cg-overlay` — 60) et
    l'overlay IDE (80) sont rendus depuis `App.tsx` **en dehors** de `.app`.
    Monté dans la TopBar sans portail, le panneau disparaissait sous eux
    quelle que soit sa valeur — 91 enfermé dans 0 perd contre 60. Symptôme
    trompeur : ça marchait au-dessus du drawer SETTINGS (70), lui rendu
    *dans* `DesktopShell`, donc dans le même contexte.
  - **z-index 90/91** — une fois sorti au niveau du body : au-dessus des
    overlays de route (60), de l'IDE (80), et des overlays console/IDE internes
    (80, où une égalité se résoudrait par l'ordre DOM *contre* le backdrop du
    panneau, monté en premier).
  - **`blocked`** — tant qu'une modale est ouverte (`showNew`, `broadcastOpen`,
    `spawnFor`, `editConfigFor`), ⌘K reste inerte. Les modales sont rendues
    dans `DesktopShell`, donc enfermées dans `.app` : le panneau portalisé
    passerait *au-dessus* d'elles, et naviguer ailleurs depuis un dialogue
    engagé le laisserait orphelin derrière soi. Refermer un panneau déjà
    ouvert reste possible.
  - **Écoute en phase de capture** — huit composants (drawer, overlays,
    modales) posent un handler `Escape` sur `window` en phase de bulle. Sans
    arbitrage, un seul Escape refermerait le panneau *et* la couche en
    dessous. La capture arrive avant tout le monde : panneau ouvert, il est la
    couche du dessus, il consomme l'événement (`stopPropagation`).
- **Focus** — `onClose` rend le focus au bouton MENU (`menuRef`), sinon le
  démontage du panneau le fait retomber sur `<body>`. Le bouton porte
  `aria-haspopup="dialog"` + `aria-expanded`. Il n'y a **pas** de piège à
  focus : le fond reste tabulable alors que le backdrop bloque la souris —
  limite connue, à reprendre si le panneau gagne en importance.
- **`switch` exhaustif** sur `LauncherActionId` terminé par
  `const _exhaustive: never = id` (idiome maison, cf. `lib/sessionStatus.ts`) :
  un id ajouté à la table casse la compilation tant qu'il n'est pas routé.
- **`noUncheckedIndexedAccess`** : `flat[cursor]` est `Item | undefined` (liste
  vide = « no match »). Le garde `if (it)` n'est pas cosmétique et ne doit pas
  être « simplifié ».
- **Grille à 5 colonnes** (`.launcher-item`) : un item ne rend jamais plus de 5
  enfants sous peine de passer à la ligne. La pastille (UPDATE) et le raccourci
  (`kbd`) occupent la même colonne — aucun item ne porte les deux.
- **CSS** : bloc `/* ==== Command launcher ==== */` copié du `<style>` du
  prototype dans `styles/desktop-theme.css`, juste après la section topbar. La
  media query des labels passe de 1280px à **720px**.

---

## 6. Vérification

```bash
cd packages/web
pnpm test          # 674 tests, dont CommandLauncher.test.tsx (17) + TopBar.test.tsx (9)
pnpm build
```

> `pnpm typecheck` (tsconfig.test.json) signale des erreurs préexistantes dans
> `SpawnWorkerDialog.test.tsx`, sans rapport avec ce step.

Puis, en réel — un changement de code n'apparaît pas sans reconstruire l'image :

```bash
docker build -t swarm-os:latest .
docker compose -f docker-compose.test.yml up -d
```

Checklist UI (penser à ré-injecter le `X-Auth-Token` de l'instance) :

1. la barre n'affiche que `+ NEW TEAM` et `MENU` ; la `health-strip` s'étale ;
2. `⌘K` ouvre le panneau, `boa` isole BOARD, `↵` navigue, `Esc` referme ;
3. `Ctrl+K` **dans un terminal agent** ne l'ouvre pas ;
4. les 9 items WORKSPACE/CREATE atteignent leur overlay (hash correct) ;
5. APPEARANCE ouvre le drawer déjà scrollé sur sa section ;
6. avec une release dispo : pastille sur MENU **et** item UPDATE dans SYSTEM ;
7. APPROVALS ouvre `#/approvals` — sans compteur chiffré (cf. §2).
