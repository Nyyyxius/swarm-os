# Step 17 (Phase D.17) — Waiting ring pulse (amber)

> Lié au plan global `docs/ui-redesign-desktop.md` §3.3 (MapView mapping,
> ligne `node-ring-pulse`), §5.1 step 17 (Phase D), §5.5 critère
> d'acceptation "waiting ring pulsant".
> Pré-requis : **Step 1** (keyframe `ring-pulse` + classe
> `.node-ring-pulse` portées dans `packages/web/src/styles/desktop-theme.css`),
> **Step 2/6** (composant `Node.tsx` qui rend déjà la branche
> `{waiting && <circle className="node-ring-pulse" .../>}`),
> **S3** (`lib/sessionStatus.ts` — `mapSessionStatusToVisual` retourne
> `{ visual: 'warn', label: 'WAITING', pulse: true }` pour `waiting`).

---

## 1. Objectif

Afficher un anneau ambre pulsant **continu** autour du node SVG dès que
`session.status === 'waiting'` (input humain attendu). Effet purement
visuel, pas de JS d'animation : keyframe CSS `ring-pulse` (1.6 s
ease-in-out infinite) qui anime opacity + stroke-width sur un `<circle>`
SVG dédié, rendu en plus du `node-ring` principal et de la `NodeShape`.

---

## 2. CSS keyframe — extrait littéral du `<style>` v2

Source : `prototypes/v2/Swarm OS v2.html` lignes **315-325** (déjà copié
dans `packages/web/src/styles/desktop-theme.css` au Step 1 — §6 du Step 6
mentionne `.node-ring-pulse` comme classe vérifiée).

```css
/* extra ring for waiting (pulsing amber outer) */
.node-ring-pulse {
  fill: none;
  stroke: var(--amber);          /* #ffb060 */
  stroke-width: 1.2;
  transform-origin: center;
  transform-box: fill-box;
  animation: ring-pulse 1.6s ease-in-out infinite;
}
@keyframes ring-pulse {
  0%, 100% { opacity: 0.25; stroke-width: 1.2; }
  50%      { opacity: 0.95; stroke-width: 1.8; }
}
```

Notes :
- `--amber = #ffb060` — même teinte que la dot status `waiting`
  (`statusDotColor('waiting') = '#ffb060'` dans `map.jsx:60`) → cohérence
  visuelle dot + ring.
- `transform-box: fill-box` permet à `transform-origin: center` de
  fonctionner sur un élément SVG sans recourir à un wrapper.
- `infinite` : tant que `status === 'waiting'`, l'anim ne s'arrête jamais.
  Le démontage React stoppe naturellement quand le status change.
- 1.6 s ease-in-out — désaturé volontairement (plus lent que les pulses
  de messagerie à 1.4 s) pour éviter de capter l'attention de manière
  agressive : c'est un "soft attention grabber".

---

## 3. Mapping status → class — cohérence avec S3

### 3.1 État actuel de `mapSessionStatusToVisual` (S3)

`packages/web/src/lib/sessionStatus.ts:48-53` :

```ts
case 'waiting':
  return {
    visual: 'warn',
    label: 'WAITING',
    pulse: true,
    tooltip: 'Attente input humain',
  };
```

Le champ `pulse: true` existe **uniquement** pour `waiting` (vérifié dans
les 8 cas du switch). Il sert déjà au `StatusBadge` (badge ambre clignotant
dans la liste). On peut donc le réutiliser **sans extension** pour piloter
le rendu de `.node-ring-pulse` côté MapView.

### 3.2 Décision : aucune extension de S3 nécessaire

Le composant `Node.tsx` (Step 2 §, lignes 463 + 479) capture le status
directement :

```tsx
const waiting = status === 'waiting';
// …
{waiting && <circle className="node-ring-pulse" r={r + 5} />}
```

C'est **équivalent fonctionnellement** à
`mapSessionStatusToVisual(status).pulse`, mais évite un import dans la
hot-path du render SVG et reste un port littéral de `v2/map.jsx`.

**Faut-il étendre `mapSessionStatusToVisual` ?** Non. Deux raisons :

1. Le `pulse: true` est déjà la source de vérité — il dit "ce status
   mérite une animation pulse". `Node.tsx` peut soit faire le test
   inline (port v2), soit appeler `mapSessionStatusToVisual(status).pulse`
   pour rester DRY. Les deux sont corrects.
2. Si demain un autre status devient "pulsant" (ex. `failed` qui clignote
   rouge), il suffira de remettre `pulse: true` dans S3 et de remplacer
   le test inline par `mapSessionStatusToVisual(status).pulse` pour
   propager automatiquement. **Pas un blocker v1.**

### 3.3 Petite divergence à acter

Le commentaire de §3.3 du plan global (`ui-redesign-desktop.md:213`)
mentionne « la classe `swarm-pulse-warn` est déjà câblée » — c'est une
**erreur de nommage** dans le plan : la classe réelle est
`.node-ring-pulse`. Pas de `swarm-pulse-warn` dans le proto ni dans S3.
À corriger en passant si on touche ce fichier (hors scope de ce step).

---

## 4. Application au Node — JSX final

Port littéral de `v2/map.jsx:99-102`, déjà spécifié au Step 2 §
(`02_desktop-skeleton.md:479`) et confirmé au Step 6 §6 (CSS vérifiée).
Aucun changement nécessaire ici, on **acte** simplement la forme finale :

```tsx
// packages/web/src/components/desktop/Node.tsx
const waiting = status === 'waiting';
// … (autres dérivations : stopped, failed, inboxCount)

return (
  <g className={`node ${spawning ? 'spawning' : ''}`} transform={…}>
    {/* 1. glow externe (amber soft) */}
    <circle
      className={`node-glow ${isLead ? 'lead' : ''} ${stopped ? 'stopped' : ''} ${waiting ? 'waiting' : ''} ${failed ? 'failed' : ''}`}
      r={r + 8}
    />

    {/* 2. extra pulsing ring — UNIQUEMENT si waiting */}
    {waiting && <circle className="node-ring-pulse" r={r + 5} />}

    {/* 3. ring principal (lead/selected/stopped/failed/starting/interrupted) */}
    <circle className={ringClass(status, isLead, selected)} r={r} />

    {/* 4. forme du role (diamond/circle/triangle/…) */}
    <NodeShape shape={agent.shape} r={r} stopped={stopped} />

    {/* 5. dot status + badge inbox + labels … */}
  </g>
);
```

Caractéristiques :
- **`r = r + 5`** : ring placé entre la `NodeShape` (rayon `r`) et le
  `node-glow` (rayon `r + 8`). Pour lead `r=26` → ring à `31` ; pour
  worker `r=20` → ring à `25`.
- **Rendu conditionnel** : `{waiting && <circle…/>}` — le `<circle>` est
  monté/démonté avec le status. Quand React démonte, l'anim CSS s'arrête
  net (pas de "fade out" — accepté tel quel, c'est le comportement v2).
- **Ordre des layers** : glow (z=1) → ring-pulse (z=2) → ring principal
  (z=3) → shape (z=4) → dot/inbox/labels (z=5). Le `ring-pulse` est
  donc visuellement **derrière** le ring principal et la shape, ce qui
  évite tout chevauchement perturbant.

---

## 5. Plan d'implémentation pas-à-pas

Step **principalement déclaratif** — la mécanique est déjà en place via
Steps 1, 2 et 6. Ce step 17 sert à valider et tester.

1. **Vérifier le CSS** : `grep -n "\.node-ring-pulse\|@keyframes ring-pulse" packages/web/src/styles/desktop-theme.css`
   doit retourner les 2 blocs du §2. Si absents → les copier littéralement
   depuis `prototypes/v2/Swarm OS v2.html:315-325`.
2. **Vérifier le JSX** : `grep -n "node-ring-pulse" packages/web/src/components/desktop/Node.tsx`
   doit retourner la ligne `{waiting && <circle className="node-ring-pulse" r={r + 5} />}`.
   Si absent → ajouter selon §4.
3. **Vérifier la source de status** : `Node` reçoit `agent.status` qui
   dérive de `enrichWithIdle(sessionView, now)` (Step 6 §4). Le status
   `'waiting'` passe à travers `enrichWithIdle` **sans modification**
   (S6 §174 : seul `running` peut être downgradé en `idle`). Donc le
   waiting backend → waiting UI 1:1, sans perte.
4. **(Optionnel) Refactor DRY** : remplacer le `const waiting = status === 'waiting'`
   inline par `const { pulse: waiting } = mapSessionStatusToVisual(status)`.
   Décision : **non**, on garde le port littéral (cf. §3.2). À reconsidérer
   si un 2ᵉ status devient pulsant.
5. **Lancer les tests unitaires existants** : `pnpm --filter @swarm-os/web test sessionStatus`
   — `mapSessionStatusToVisual('waiting').pulse === true` doit rester
   vrai. Pas de test DOM à ajouter (Node.tsx ne change pas).
6. **Docker rebuild** puis smoke test §6.

---

## 6. Tests de fumée

À exécuter après `docker build -t swarm-os:latest . && docker compose -f docker-compose.test.yml up -d`.

| # | Geste | Attendu |
|---|-------|---------|
| 1 | Créer un orchestrator `WAIT-TEST` (role RESEARCHER, 1 worker) | Lead + worker apparaissent sans ring-pulse (status `running` ou `starting`). |
| 2 | Déclencher waiting côté worker — option A : invoquer un PTY prompt qui attend stdin (ex. agent qui pose une question via `team.send_message` à `from: 'human'` puis attend la réponse). Option B : forcer via `POST /sessions/:id/status` si endpoint dev existe ; sinon attendre une vraie pause input. | Le node worker affiche un anneau ambre `#ffb060` qui pulse (opacity 0.25 ↔ 0.95 toutes les 1.6 s). Le status-dot upper-right passe ambre `#ffb060`. Toast `SESSION WAITING` apparaît bas-droite (`NotificationPanel` / `Toasts`). |
| 3 | Vérifier dans le DevTools Elements → le `<g class="node">` contient bien deux `<circle>` superposés : `node-ring-pulse` (r=25) **avant** le `node-ring` (r=20). Anim CSS `ring-pulse 1.6s ease-in-out infinite` listée dans Computed > animations. | Conforme. |
| 4 | Résoudre le waiting (envoyer la réponse via composer PTY ou `postSessionInput`) → status repasse à `running`. | Le `<circle class="node-ring-pulse">` est démonté du DOM (React diff). Le status-dot redevient vert `#6ec48a`. |
| 5 | Mettre plusieurs sessions en `waiting` simultanément (2-3 orchestrators) | Chaque node concerné affiche son propre ring pulsant — anims **non synchronisées** par défaut (chaque `<circle>` démarre son anim au mount → décalage naturel). Acceptable. |
| 6 | Tester `prefers-reduced-motion: reduce` (Chrome DevTools Rendering > Emulate CSS media feature) | **Connu** : l'anim continue (pas de `@media (prefers-reduced-motion)` dans le CSS porté v2). Non-blocker v1 ; à ajouter en polish ultérieur si demande. |
| 7 | Status `paused` (S5) | **Pas de ring-pulse** (S3 : `pulse: false` pour `paused`). Vérifier que le pause cohabite avec un autre rendu (chip warn statique). |
| 8 | Status `failed`, `interrupted`, `starting` | **Pas de ring-pulse**. Le `node-ring` lui-même change de classe (`failed/interrupted/starting`) — c'est le `ringClass(status,…)` qui gère, indépendant du ring-pulse. |
| 9 | Restart du serveur pendant un waiting → reconnect | Status passe à `interrupted` (S5), ring-pulse disparaît, ring principal devient `interrupted` (dashed gris-brun). Au prochain heartbeat, si la session revient `waiting`, le ring-pulse réapparaît. |
| 10 | Inspecter la perf : 5 nodes waiting en simultané → onglet Performance / Layers | Animation GPU-composited (opacité + stroke-width = layout-free sur SVG). FPS stable ≥ 60. |

---

## 7. Hors scope (notes pour plus tard)

- **`prefers-reduced-motion`** : pas dans le CSS v2 ; à ajouter un
  `@media (prefers-reduced-motion: reduce) { .node-ring-pulse { animation: none; opacity: 0.7; } }`
  en step polish accessibilité (transverse à Steps 15-17).
- **Pulse-fade `node-glow.waiting`** : le CSS v2 (ligne 326-329) définit
  aussi un `@keyframes pulse-fade` qui anime l'opacité du `node-glow`
  classe `.waiting`. Vérifier au Step 1 que cette keyframe + la règle
  `.node-glow.waiting { animation: pulse-fade …; }` sont aussi portées —
  c'est un effet **complémentaire** au ring-pulse (le halo respire en
  même temps). Hors scope strict du Step 17 (qui ne concerne que le
  `.node-ring-pulse`), mais à valider conjointement.
- **Désynchronisation volontaire** : si on veut un effet "vague" plutôt
  que des anims indépendantes, on pourrait passer `animation-delay`
  basé sur `agent.id` (hash modulo). Pas dans le proto, pas demandé v1.
