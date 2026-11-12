# S3 — Statut session `waiting` distinctement visible

> Analyse d'implémentation détaillée pour le chantier S3 décrit dans
> `docs/internal/ui-redesign/update_system.md`. Frontend uniquement, aucun changement serveur.

---

## 1. Résumé du besoin

Le serveur expose déjà un enum `SessionStatus` riche (7 valeurs) mais
le prototype desktop ne connaît qu'un vocabulaire visuel à 4 états
(`running / idle / warn / stopped`). Aujourd'hui le composant
`StatusBadge` rend chaque valeur backend telle quelle avec une couleur
distincte — c'est suffisant pour debug, **mais perd le sens
opérationnel** : `waiting` (attente input humain) doit sauter aux yeux
et `failed` doit être distinct de `stopped` (rouge vs gris).

Il faut formaliser un **mapping `SessionStatus → VisualStatus`** côté
frontend, exposer une fonction réutilisable et l'appliquer partout où
un statut session est rendu (badge, dot dans la map, ring autour des
nodes, panneau de droite). La pulsation visuelle de `waiting` est le
point central — c'est le signal qui justifie déjà les toasts du
`NotificationPanel`.

## 2. État actuel

### Enum serveur (autoritative)

`packages/server/src/modules/orchestrator/session.ts:22-29`

```ts
export type SessionStatus =
  | 'starting'
  | 'running'
  | 'waiting'
  | 'exited'
  | 'killed'
  | 'interrupted'
  | 'failed';
```

Le serveur émet `session.waiting` et `session.status_changed` (cf.
`packages/server/src/modules/orchestrator/session.ts:295` et
`hooks.ts`). Le statut `waiting` est posé par le hook `StopHook` côté
Claude — bien réel, pas un placeholder.

### Type client (mirror)

`packages/web/src/api/client.ts:68` redéclare exactement les 7
valeurs — donc TypeScript va nous protéger d'un mapping incomplet
(via un `switch` exhaustif).

### Composant existant `StatusBadge.tsx`

Map directe `SessionStatus → classes Tailwind` (9 entrées, dont
`stopping` qui n'appartient pas à `SessionStatus` mais au statut
**orchestrator** — léger bug de typage). Chaque valeur backend a sa
propre couleur (7 couleurs distinctes), **aucune pulsation, aucun
regroupement sémantique**. Pas de fonction de mapping centralisée.

### Consommateurs identifiés

- `components/OrchestratorList.tsx:113` — badge statut **orch**.
- `components/OrchestratorView.tsx:106` — badge statut orch (header).
- `components/OrchestratorView.tsx:200` — badge statut **session**.
- `hooks/useEvents.ts:106-107` — détection `payload.status === 'waiting'`
  pour les toasts (logique côté événement, indépendante du mapping).
- `components/NotificationPanel.tsx` — affichage des toasts waiting.

`OrchestratorList` connaît déjà `TERMINAL_STATUSES = new Set(['stopped', 'failed'])`.

### Prototype desktop (cible visuelle)

`prototypes/Swarm OS.html:20-28` définit la palette officielle :

```css
--ok:      #6ec48a;   /* running       */
--warn:    #e8b04a;   /* waiting       */
--bad:     #e0654a;   /* failed        */
--stopped: #5a4d3f;   /* exited/killed */
```

`prototypes/map.jsx:54-60` (`statusDotColor`) confirme les 4 niveaux
visuels (`running / warn / idle / stopped`). `panels.jsx:186-188`
attribue les chips `ok / warn / stopped`. **Aucun état `bad`/rouge
n'est encore câblé dans la map** — il faut l'ajouter (cf. S3
explicite : « état distinct, à ajouter au design »).

### Tests existants

`packages/web/src/components/StatusBadge.test.tsx` : test paramétré
qui vérifie que chaque valeur backend rend une classe contenant le
nom de famille de couleur (`amber`, `emerald`, etc.). Sera à refactor
pour matcher le nouveau mapping.

## 3. Fichiers à modifier (frontend uniquement)

| Fichier | Changement |
|---|---|
| `packages/web/src/lib/sessionStatus.ts` (**nouveau**) | Type `VisualStatus`, fonction `mapSessionStatusToVisual()`, table des libellés et couleurs |
| `packages/web/src/components/StatusBadge.tsx` | Réécrit sur la base du visual status, ajout d'une variante `pulse` |
| `packages/web/src/components/StatusBadge.test.tsx` | Adapté aux nouvelles classes/libellés |
| `packages/web/src/index.css` | Ajouter `@keyframes swarm-status-pulse` + classe utilitaire `.status-pulse` (Tailwind v4, donc déclaration CSS pure) |
| `packages/web/src/components/OrchestratorView.tsx` | Vérifier que les deux usages de `StatusBadge` exploitent le mapping (rien à faire si on garde la même API) |

> **Aucun fichier serveur** modifié. Aucun fichier `*.html` du proto
> modifié — c'est un mockup, pas du code prod.

## 4. Plan d'implémentation

### 4.1 Nouveau module `lib/sessionStatus.ts`

Exporte :

- `type VisualStatus = 'idle' | 'running' | 'warn' | 'bad' | 'stopped'`.
- `interface VisualDescriptor { visual: VisualStatus; label: string; pulse: boolean; tooltip?: string }`.
- `mapSessionStatusToVisual(s: SessionStatus): VisualDescriptor` — un
  `switch` **exhaustif** (sans `default`) qui suit la table §5. Le
  TypeScript garantit que l'ajout de `paused` (S5) **cassera la
  compilation** — comportement souhaité.
- `mapOrchestratorStatusToVisual(s: OrchestratorStatus)` séparé pour
  gérer `stopping → idle` ; les valeurs communes (`starting`,
  `running`, `stopped`, `failed`) renvoient le même descripteur.

### 4.2 Réécriture `StatusBadge.tsx`

- Lookup `Record<VisualStatus, string>` (5 entrées Tailwind) au lieu
  de la `Record<string, string>` à 9 entrées actuelle.
- Applique la classe `status-pulse` ssi `descriptor.pulse === true`.
- Met le `descriptor.tooltip` dans l'attribut `title` natif (v1
  suffisant ; on passera à un vrai `<Tooltip>` quand on portera le
  design desktop).
- Affiche le `descriptor.label` (en MAJUSCULES) au lieu du raw status.

### 4.3 CSS pour la pulsation

Ajouter à `packages/web/src/index.css` :

```css
@keyframes swarm-status-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(232, 176, 74, 0.45); }
  50%      { box-shadow: 0 0 0 6px rgba(232, 176, 74, 0.00); }
}
.status-pulse { animation: swarm-status-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .status-pulse { animation: none; } }
```

Pourquoi pas `animate-pulse` de Tailwind ? Parce qu'il anime
`opacity`, ce qui rend le badge **moins** lisible. Le proto utilise
déjà `box-shadow: 0 0 6px var(--warn)` sur `.dot.warn` — cohérent.

### 4.4 Points d'appel

- **StatusBadge** : déjà utilisé dans `OrchestratorList` et
  `OrchestratorView` — aucune modification d'appelant.
- **MapView** (à venir, cf. proto `map.jsx`) : exposera la fonction
  pour calculer `statusDotColor` et `pulse` directement depuis la
  donnée serveur. Importer `mapSessionStatusToVisual` plutôt que
  recoder la logique.
- **TopBar** (`team-pill` du proto) : agrège au niveau orchestrator,
  mais le `pulse` doit déclencher si **au moins une session** est en
  `waiting`. Logique à placer dans le composant team-pill quand il
  sera porté.
- **RightPanel** (`pr-status` chip) : utilise le visual + le label
  long.
- **Prototypes (`prototypes/*.jsx`)** : ne pas toucher. Les
  prototypes sont du mockup, pas de la dette technique.

## 5. Schéma de design

### Mapping visuel détaillé

| Backend | VisualStatus | Couleur (var) | Pulse | Label | Tooltip |
|---|---|---|---|---|---|
| `starting`    | idle    | slate (muted)        | non | STARTING    | — |
| `running`     | running | `--ok` (#6ec48a)     | non | RUNNING     | — |
| `waiting`     | warn    | `--warn` (#e8b04a)   | **oui** | WAITING | Attente input humain |
| `exited`      | stopped | `--stopped` (#5a4d3f)| non | EXITED      | Process terminé normalement |
| `killed`      | stopped | `--stopped`          | non | KILLED      | Killed by operator |
| `interrupted` | stopped | `--stopped`          | non | INTERRUPTED | Server restart |
| `failed`      | bad     | `--bad` (#e0654a)    | non | FAILED      | Erreur process |

### Lien avec `update_UI.md` (U0.6)

Cette table est **identique** à celle de `docs/internal/ui-redesign/update_UI.md:149-158`.
Les deux documents doivent rester synchronisés. La table maître vit
maintenant **dans le code** (`lib/sessionStatus.ts`) — les docs
réfèrent vers ce module.

### Différenciation `exited / killed / interrupted`

Tous trois mappent visuellement vers `stopped`, mais :

- **Tooltip** distinct sur le badge.
- **Label** distinct dans le badge (EXITED vs KILLED vs INTERRUPTED).
- Le `pr-stats` (RightPanel, à venir) pourra ajouter une ligne
  `EXIT REASON` (cf. U0.6 du `update_UI.md`).

### État `bad` rouge à câbler dans le proto

Le proto a la variable `--bad` mais ne l'utilise pour aucun statut
(seulement pour `WARN`/`ERR` dans la console et le hover du bouton
`danger`). S3 demande explicitement d'ajouter cet état au design — il
faut prévoir une classe `.dot.bad` et `.ring.bad` quand on portera la
MapView en React.

## 6. Tests à écrire

### Unitaires (`lib/sessionStatus.test.ts`)

- Pour chaque `SessionStatus` du type union, `mapSessionStatusToVisual`
  retourne le bon `VisualStatus`, le bon label, le bon `pulse`.
- `mapSessionStatusToVisual('waiting').pulse === true` (le seul cas).
- `mapSessionStatusToVisual('failed').visual === 'bad'`.
- Test d'exhaustivité : itérer sur un tableau littéral typé
  `SessionStatus[]` qui contient les 7 valeurs ; si on ajoute `paused`
  via S5 sans étendre le mapping, le compilateur plante (test de
  régression à la compilation, pas runtime).

### Unitaires (`StatusBadge.test.tsx`)

- `waiting` → la classe contient `amber` ET `status-pulse`.
- `failed` → la classe contient `red` (groupe `bad`), pas `status-pulse`.
- `killed` → label `KILLED` mais classe slate (groupe `stopped`).
- Tooltip présent sur `killed` / `interrupted`.

### Test visuel manuel

1. Démarrer un orch via `New orchestrator`.
2. Laisser le lead atteindre `running`, vérifier badge vert sans
   pulsation.
3. Attendre que le lead émette le hook `Stop` (= passe `waiting`) →
   badge ambre **pulse**.
4. Envoyer un input PTY → repasse `running`, pulse s'arrête.
5. `destroyOrchestrator` → badge `KILLED` gris avec tooltip
   `Killed by operator`.
6. Provoquer un échec (model invalide, etc.) → badge `FAILED` rouge,
   pas de pulsation.
7. Tester `prefers-reduced-motion: reduce` (Chrome devtools →
   Rendering → Emulate CSS media feature) : la pulsation s'arrête.

## 7. Gotchas

- **Perte de `waiting` si on mappe naïvement** : piège principal. Un
  `status === 'running' ? green : grey` fait disparaître `waiting`
  dans le bucket gris. Le `switch` exhaustif protège.
- **Pulsation CSS** : `animate-pulse` de Tailwind anime l'opacité —
  rend le badge **moins** lisible. Définir `@keyframes` `box-shadow`
  à la main + respecter `prefers-reduced-motion`.
- **`paused` arrive avec S5** : extension d'enum côté serveur
  (`update_system.md:106-107`) cassera la compilation du switch — c'est
  voulu (filet de sécurité). À ce moment, ajouter
  `case 'paused': return { visual: 'idle', label: 'PAUSED', pulse: false }`.
- **`StatusBadge` partagé orch/session** : aujourd'hui accepte
  `status: string`. Typer strictement avec deux helpers
  (`mapSessionStatus…` et `mapOrchestratorStatus…`) qui partagent
  `VisualStatus`. `stopping` (orch uniquement) → `idle`.
- **Re-renders** : la pulsation est CSS pure, aucun state React. Une
  session waiting ne re-render qu'à `session.status_changed`.
- **Tailwind ≠ vars CSS du proto** : la `web` app utilise les couleurs
  Tailwind, le proto a des `--warn`/`--bad`/`--ok`. Quand on portera
  le design desktop (cf. `ui-redesign-desktop.md`) seule la table
  `VISUAL_CLASSES` bougera ; `mapSessionStatusToVisual` reste
  inchangée.

## 8. Dépendances avec autres tickets

| Ticket | Lien |
|---|---|
| **S5** (`paused`) | Étendra `SessionStatus`. Le switch exhaustif force l'extension du mapping. `paused → idle` (gris clair, distinct de `stopped` foncé). Aucune blocage en ordre, S3 peut livrer avant. |
| **S6** (idle dérivé `lastActivityAt`) | Si on choisit l'alternative low-effort (calcul frontend), `mapSessionStatusToVisual` recevra `running` mais le composant appelant pourrait surcharger en `idle` si `now - lastActivityAt > 30s`. Préférable : exposer une fonction `enrichWithIdle(session)` à part qui se branche en amont du mapping. |
| **S7** (`health` orchestrator) | Le `team-pill` de la TopBar agrège les statuts session pour décider `HEALTHY / DEGRADED / OFFLINE / FAILED`. Règle : si un worker est `failed` ou un lead est `waiting`, la team passe `DEGRADED` (warn). Le calcul peut réutiliser `mapSessionStatusToVisual` pour standardiser : `health = some(s => visual(s) === 'bad') ? 'bad' : some === 'warn' ? 'warn' : 'ok'`. |
| **U0.4** (toasts waiting) | Déjà OK, indépendant. Le badge ne fait que doubler le signal du toast. |
| **U0.6** (statuts lifecycle complet) | Cible directe de S3. La table dans `update_UI.md:150-158` doit pointer vers `lib/sessionStatus.ts`. |

## 9. Critères d'acceptation vérifiables

1. **Fichier `packages/web/src/lib/sessionStatus.ts`** exporte
   `mapSessionStatusToVisual` et le type `VisualStatus = 'idle' | 'running' | 'warn' | 'bad' | 'stopped'`.
2. **Pour chaque `SessionStatus`**, la fonction retourne un
   descripteur dont `visual` correspond à la table de la §5 (validé
   par tests unitaires).
3. **`waiting` est le seul statut avec `pulse: true`** (test
   unitaire dédié).
4. **Le composant `StatusBadge`** applique la classe `status-pulse`
   ssi le descripteur le demande (test d'intégration).
5. **L'animation CSS `swarm-status-pulse`** est définie dans
   `index.css` et respecte `prefers-reduced-motion: reduce`
   (vérif visuelle).
6. **`failed` rend rouge (`bg-red-*` / `text-red-*`)**, pas slate
   (test unitaire + visuel).
7. **`killed` et `interrupted`** rendent **gris** (groupe `stopped`)
   mais leurs **labels et tooltips diffèrent** (test unitaire).
8. **Pas de régression** : `pnpm -F @swarm-os/web test` passe ;
   `pnpm -F @swarm-os/web build` passe sans erreur TypeScript.
9. **Aucun fichier serveur touché** dans le diff de S3 (revue git).
10. **Ajout de `paused`** (S5 plus tard) provoque une erreur de
    compilation TS sur le `switch` non-exhaustif (test de robustesse
    documenté, à valider lors de S5).
