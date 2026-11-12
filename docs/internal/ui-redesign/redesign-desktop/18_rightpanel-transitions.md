# Step 18 — RightPanel open/close transitions

> Phase D.18 — animations & polish. Référence brief :
> `docs/internal/ui-redesign/ui-redesign-desktop.md` §5.1 ligne 397-398 ; recensement CSS :
> `docs/internal/ui-redesign/redesign-desktop/01_design-system-v2.md` §3.4 (table « Main
> grid ») ; close button déjà documenté : `07_rightpanel-data-binding.md`
> ligne 997 (et squelette Step 2 : `02_desktop-skeleton.md` ligne 1633).

---

## 1. Objectif

Faire glisser le `RightPanel` hors-écran vers la droite quand aucune
session n'est sélectionnée (`selectedSessionId === null`), et le ramener
en place quand l'utilisateur clique un node sur la MapView ou une
team-pill dans la TopBar/LeftPanel. Le bouton `×` du `pr-head` doit
fermer le panneau (`selectedSessionId → null`) en déclenchant la même
transition.

Comme tout l'enrobage CSS + JSX a déjà été porté dans les Steps 1, 2 et
7, **Step 18 est essentiellement « vérification » + un ajout
conditionnel d'une classe** dans `RightPanel.tsx`. Aucune nouvelle
règle CSS, aucun nouveau handler.

---

## 2. CSS transition — extrait littéral du HTML v2

Source : `prototypes/Swarm OS.html` lignes 112-129 (le HTML v2 de
référence ; le fichier `Swarm OS v2.html` n'existe plus, c'est `Swarm
OS.html` qui contient le `<style>` à porter).

```css
/* ============ Main grid ============ */
.main {
  display: grid;
  grid-template-columns: 320px 1fr 380px;
  overflow: hidden;
}
.panel-left, .panel-right {
  background: var(--panel-solid);
  overflow: hidden;
  display: flex; flex-direction: column;
  z-index: 10;
}
.panel-left { border-right: 1px solid var(--border); }
.panel-right {
  border-left: 1px solid var(--border);
  transition: transform 280ms cubic-bezier(.2,.7,.2,1);
}
.panel-right.closed { transform: translateX(100%); pointer-events: none; }
```

Notes vs brief :
- Le brief annonce « ~250ms ease-out ». Le proto est en **280ms
  cubic-bezier(.2,.7,.2,1)** — on garde le proto (visuel déjà validé).
- `pointer-events: none` sur `.closed` évite que les boutons cachés
  (composer, actions) restent cliquables hors-écran pendant l'anim.

Vérification : ces 4 sélecteurs (`.main`, `.panel-left`, `.panel-right`,
`.panel-right.closed`) sont listés dans
`01_design-system-v2.md:210` (table « Main grid », lignes 168-188 du
HTML d'extraction). **CSS déjà porté en Step 1** dans
`packages/web/src/styles/desktop-theme.css` (à créer par Step 1) — rien
à ajouter ici.

---

## 3. State management

### 3.1 Source unique : `selectedSessionId` dans `DesktopShell`

Déclaré en Step 2 (`02_desktop-skeleton.md:2130`) :

```tsx
const [selectedId, setSelectedId] = useState<string | null>(null);
```

> Le squelette nomme la variable `selectedId` ; Step 7 et au-delà la
> renomment `selectedSessionId` (`07_rightpanel-data-binding.md:243`).
> Step 18 ne change rien — il consomme cet état.

Cycle de vie :
- `null` au mount → panneau fermé (slid out).
- Clic sur un node MapView / team-pill TopBar / team-row LeftPanel →
  `selectAgent(id)` → `setSelectedSessionId(id)` → panneau s'ouvre.
- Clic sur `×` du `pr-head` → `onClose()` → `selectAgent(null)` →
  `setSelectedSessionId(null)` → panneau se ferme.
- Edge case « session disparaît » (§7 — `useSession` ne la trouve plus)
  → `selectedSession` devient `undefined` → `selected = null` → panneau
  se ferme automatiquement (voir `07_rightpanel-data-binding.md:1678`).

### 3.2 Callback `onClose`

Déjà câblé Step 2 (`02_desktop-skeleton.md:2217`) :

```tsx
<RightPanel
  ...
  onClose={() => selectAgent(null)}
  ...
/>
```

Le bouton `×` (`pr-close`) est déjà rendu Step 2/7
(`02_desktop-skeleton.md:1633`, `07_rightpanel-data-binding.md:997`) :

```tsx
<button className="pr-close" onClick={onClose} title="close">×</button>
```

→ **Rien à ajouter côté handler ; rien à ajouter côté markup du bouton.**

---

## 4. JSX changes — la SEULE modification réelle de Step 18

Telle qu'écrite actuellement (Steps 2 + 7), la branche « pas de
sélection » utilise déjà `panel-right closed` :

```tsx
if (!selected || !team) {
  return (
    <aside className="panel-right closed">
      <div className="pr-empty"><div className="pr-empty-inner">no agent selected</div></div>
    </aside>
  );
}
```

…mais elle **démonte** tout le contenu (head, tabs, composer) et le
**remonte** dès qu'une session est sélectionnée. Conséquence : la
transition CSS `transform 280ms` ne s'applique qu'à la version `closed`
(vide), parce que la version « ouverte » est un **autre élément DOM** —
React n'anime pas un swap d'éléments, il les remplace.

→ Pour que la slide-in/out fonctionne **réellement**, il faut un
**unique** `<aside className="panel-right">` dont le contenu reste
monté, et la classe `closed` ajoutée conditionnellement :

```tsx
// AVANT (Step 7)
if (!selected || !team) {
  return (
    <aside className="panel-right closed">
      <div className="pr-empty">…</div>
    </aside>
  );
}
return (
  <aside className="panel-right">
    <div className="pr-head">…</div>
    …
  </aside>
);

// APRÈS (Step 18)
const isClosed = !selected || !team;
return (
  <aside className={`panel-right${isClosed ? ' closed' : ''}`}
         aria-hidden={isClosed}>
    {isClosed ? (
      <div className="pr-empty">
        <div className="pr-empty-inner">no agent selected</div>
      </div>
    ) : (
      <>
        <div className="pr-head">…</div>
        …
      </>
    )}
  </aside>
);
```

Subtilité importante :
- On garde **deux contenus distincts** (empty vs full) parce que le
  contenu plein dépend de `selected` non-null (TypeScript narrowing).
  Le slide est porté par le wrapper `<aside>` qui reste, lui, monté.
- L'`<aside>` n'est jamais démonté → la transition CSS s'applique au
  retrait **et** au retour.
- `aria-hidden={isClosed}` évite que les lecteurs d'écran annoncent le
  panneau quand il est hors-champ.

Alternative envisagée puis rejetée : garder le full contenu monté en
permanence et le rendre conditionnellement vide via guards internes.
Coûteux (Terminal xterm.js inutilement instancié sans selection) et
mémoire en hausse. La version retenue ci-dessus est le meilleur
compromis : `<aside>` toujours monté (donc transition), contenu lourd
monté uniquement quand `selected !== null`.

---

## 5. Animation grid impact — la colonne 380px reste réservée

`grid-template-columns: 320px 1fr 380px;` ne change **jamais** :
- Quand `.panel-right.closed`, seule la `transform` est animée. La
  cellule grid de 380px **reste allouée** (l'élément occupe toujours sa
  cellule, il est juste translaté).
- Conséquence : la `MapView` (cellule `1fr`) **ne s'élargit pas** quand
  le panneau se ferme. C'est conforme au proto v2 — l'utilisateur garde
  une référence visuelle stable.
- Trade-off accepté : 380px d'espace « vide » à droite quand panneau
  fermé. Si une vraie « map fullscreen » est souhaitée plus tard, ce
  sera un Step ultérieur (ajouter une règle `.main.no-right {
  grid-template-columns: 320px 1fr 0; }` + transition sur
  `grid-template-columns` — non-trivial, hors-scope Step 18).
- `pointer-events: none` garantit qu'aucun clic ne « tombe » sur la
  zone vide où le panneau était.

→ **Aucune modification du grid layout.** La règle `.main` portée Step
1 reste inchangée.

---

## 6. Plan d'implémentation pas-à-pas

Prérequis :
- Step 1 livré → `desktop-theme.css` contient `.panel-right`,
  `.panel-right.closed`, `.main`.
- Step 2 livré → `DesktopShell.tsx` détient `selectedId` +
  `selectAgent(null)` câblé sur `onClose`.
- Step 7 livré → `RightPanel.tsx` rend bouton `pr-close` + branche
  empty `panel-right closed`.

Étapes Step 18 :

1. **Vérifier le CSS en place** dans
   `packages/web/src/styles/desktop-theme.css` :
   - Sélecteur `.panel-right { transition: transform 280ms
     cubic-bezier(.2,.7,.2,1); border-left: 1px solid var(--border); }`
   - Sélecteur `.panel-right.closed { transform: translateX(100%);
     pointer-events: none; }`
   - Si l'un manque, **patcher Step 1** (et noter le gap dans le
     commit). Ne **pas** dupliquer ces règles ailleurs.

2. **Refactor `packages/web/src/components/desktop/RightPanel.tsx`** :
   - Remplacer la double-branche `if (!selected || !team) return <aside
     className="panel-right closed">…</aside>; return <aside
     className="panel-right">…</aside>;` par un unique
     `<aside className={`panel-right${isClosed ? ' closed' : ''}`}
     aria-hidden={isClosed}>` avec contenu ternaire (voir §4).
   - Garder le early-return des dérivées (`const isLead = …`, `const
     status = …`) sous un narrow `if (!selected || !team) return …
     empty …;` **seulement** si nécessaire pour TS — sinon utiliser un
     ternaire dans le return.

3. **Vérifier `DesktopShell.tsx`** :
   - `onClose={() => selectAgent(null)}` déjà présent
     (`02_desktop-skeleton.md:2217`). Ne pas modifier.
   - `selectedSessionId` (= `selectedId`) reste source unique. Ne pas
     ajouter de state local `isPanelOpen` redondant.

4. **Vérifier qu'aucun autre composant** (MapView, TopBar, LeftPanel) ne
   manipule `selectedSessionId` autrement que par `selectAgent(id |
   null)`. Sinon, harmoniser.

5. **Test manuel** (voir §7) puis commit :
   `Feat(desktop): RightPanel slide-in/out transition (Step 18)`.

---

## 7. Tests de fumée

### 7.1 Visuel — transition fluide

- [ ] Au boot (`selectedSessionId === null`), le panneau droit est
      hors-écran. La colonne 380px de la grid est vide (background
      visible).
- [ ] Cliquer un node lead sur MapView → panneau glisse depuis la
      droite en ~280ms (cubic-bezier ease-out), contenu (`pr-head`,
      tabs, composer) visible une fois la transition terminée.
- [ ] Cliquer `×` dans `pr-head` → panneau glisse hors-écran en ~280ms.
      `selectedSessionId` repasse à `null`.
- [ ] Cliquer un autre node pendant que le panneau est ouvert → pas de
      slide (déjà ouvert), le **contenu** change (head + console +
      messages) sans saccade. Le `useEffect([selected?.id])` reset le
      draft (`07_rightpanel-data-binding.md:1684`).

### 7.2 Layout stable

- [ ] Ouvrir / fermer le panneau plusieurs fois : la `MapView` ne
      change **jamais** de largeur (la colonne 380px reste réservée).
- [ ] Pas de scroll horizontal global pendant la transition (le
      `overflow: hidden` de `.main` doit clipper le translate).

### 7.3 Accessibilité & interactions cachées

- [ ] Quand le panneau est `closed`, cliquer dans la zone vide à droite
      ne déclenche aucun handler (`pointer-events: none`).
- [ ] `aria-hidden="true"` présent quand `closed`, absent quand ouvert
      (vérifier dans DevTools).
- [ ] Tab navigation : le focus ne tombe pas sur des boutons hors-champ
      quand le panneau est fermé (combo `aria-hidden` + `pointer-events`
      suffit pour la plupart des AT ; si besoin futur d'inert, voir
      polyfill).

### 7.4 Edge cases

- [ ] Sélectionner une session, puis la kill (depuis un autre client
      ou via API directe) → `useSession` retourne `undefined` →
      `selected` devient `null` → panneau slide out automatiquement
      (`07_rightpanel-data-binding.md:1678`).
- [ ] Resize fenêtre pendant la transition : pas de glitch (la
      `transform` est en pourcentage de l'élément, indépendant du
      viewport).
- [ ] `prefers-reduced-motion` : non géré Step 18 (gap connu). Si
      besoin futur, ajouter `@media (prefers-reduced-motion: reduce) {
      .panel-right { transition: none; } }` dans `desktop-theme.css`.

### 7.5 Régression

- [ ] Composer, console (xterm.js), CONFIG tab continuent à fonctionner
      identiquement quand panneau ouvert (cf. tests Step 7 §12).
- [ ] `ConfirmModal` (KILL/STOP) s'affiche par-dessus le panneau sans
      jank.

---

## 8. Récapitulatif fichiers touchés

| Fichier | Type | Modification |
|---|---|---|
| `packages/web/src/styles/desktop-theme.css` | VERIFY | s'assurer que `.panel-right { transition: transform 280ms cubic-bezier(.2,.7,.2,1); }` et `.panel-right.closed { transform: translateX(100%); pointer-events: none; }` sont présents (porté Step 1). Patch Step 1 si manquant. |
| `packages/web/src/components/desktop/RightPanel.tsx` | EDIT | unifier les deux branches sous un seul `<aside>` avec classe conditionnelle `closed` + `aria-hidden`, contenu ternaire empty / full. |
| `packages/web/src/components/desktop/DesktopShell.tsx` | NO-OP | `onClose={() => selectAgent(null)}` déjà câblé Step 2/7. |

**Aucune dépendance npm, aucun changement serveur, aucun nouveau
endpoint, aucun nouveau hook.** Step 18 = polish CSS + 1 refactor JSX
mineur (~15 lignes diff dans `RightPanel.tsx`).
