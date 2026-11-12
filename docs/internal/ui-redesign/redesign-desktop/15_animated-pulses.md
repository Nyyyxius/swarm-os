# Step 15 (Phase D.15) — Animated pulses via `offset-path`

> Lié au plan global `docs/internal/ui-redesign/ui-redesign-desktop.md` §3.3 (MapView mapping —
> ligne pulses), §5.1 step 15 (Phase D), §5.4 risque #2 (cap 32 perf).
> Pré-requis : **Step 1** (keyframes `pulse-travel` + classes `.pulse-dot`
> dans `desktop-theme.css`) **et** **Step 6** (pipeline `mailbox.message` →
> `MapPulse[]`, derivekind, pushPulse, dedupe 200 ms, cap 32). La quasi-
> totalité du pipeline animation a en réalité été spécifiée au Step 6 ;
> ce Step 15 (Phase D) **acte** et **valide** le rendu visuel (CSS
> `offset-path` + lifecycle DOM) sans rien réinventer.

---

## 1. Objectif

Animer les `<circle className="pulse-dot …">` du SVG MapView le long des
edges entre nodes (lead↔hub, lead↔worker, hub↔lead pour cross/human/
broadcast) via CSS pur — pas de JS d'animation frame-by-frame, pas de
`requestAnimationFrame`. Chaque pulse traverse un path SVG calculé via
`curveBetween(from, to)` en utilisant `offset-path: path(...)` + un
`@keyframes pulse-travel` qui anime `offset-distance: 0% → 100%`. À
l'expiration, le pulse reste figé à `100%` (donc invisible — opacity 0 sur
la dernière keyframe), puis est retiré du DOM par le cleanup différé
spécifié Step 6 §5.5 (cap 32 + slice à T+1500 ms).

---

## 2. Source CSS — extrait littéral du `<style>` v2

Toutes les règles ci-dessous viennent de `prototypes/v2/Swarm OS v2.html`
et sont **déjà copiées** dans `packages/web/src/styles/desktop-theme.css`
par Step 1 (vérification §11 / §6 du Step 6). On les rappelle pour la
revue de Step 15 :

### 2.1 Keyframe `pulse-travel` (HTML v2 ligne 389-394)

```css
@keyframes pulse-travel {
  from { offset-distance: 0%; opacity: 0; }
  10%  { opacity: 1; }
  90%  { opacity: 1; }
  to   { offset-distance: 100%; opacity: 0; }
}
```

Notes :
- L'opacité fade in/out aux 10 % de bornes — invisible pile au départ et
  pile à l'arrivée, ce qui masque le "saut" perceptible à l'apparition /
  disparition du DOM node.
- Pas de `transform` : l'animation `offset-distance` déplace l'élément
  le long de son `offset-path` natif.

### 2.2 Classe `.pulse-dot` (HTML v2 ligne 719-721)

```css
.pulse-dot          { fill: var(--amber); filter: drop-shadow(0 0 4px var(--amber)); }
.pulse-dot.human    { fill: var(--text);  filter: drop-shadow(0 0 4px var(--text)); }
.pulse-dot.broadcast{ fill: var(--amber); filter: drop-shadow(0 0 6px var(--amber)); }
```

Notes :
- 3 classes seulement → 3 styles visuels distincts. Le 4ᵉ kind logique
  (`cross`) **n'a pas** de classe CSS dédiée : il rend exactement comme
  `intra` (ambre, drop-shadow 4 px). La distinction `cross` vs `intra` est
  préservée logiquement (origine `__center__` au lieu du peer), mais le
  visuel converge. Voir §3 ci-dessous (le brief mentionne 4 kinds → 3
  variantes visuelles, c'est conforme au prototype, **on ne rajoute pas
  de classe `cross`**).
- `--amber` = `#ffb060` ; `--text` = `#f3e9dc`. Le pulse `human` est donc
  blanc-crème, immédiatement distinguable du flux agent-to-agent ambré.
- Le `drop-shadow` SVG fait le glow sans coût supplémentaire (filter GPU
  composited).

### 2.3 `.center-hub` & contexte (rappel)

Les pulses partent / arrivent souvent du hub (`__center__` = `{x: 600,
y: 450}`). Pas de classe dédiée au pulse côté hub — c'est juste un point
d'ancrage du path.

---

## 3. Modèle `MapPulse` — interface TypeScript

Défini Step 6 §5.5 (à placer dans `packages/web/src/components/desktop/
pulses.ts`). Rappel littéral pour Step 15 — **aucun changement** :

```ts
export interface MapPulse {
  id: number | string;     // monotone via pulseIdRef.current++ dans DesktopShell
  from: string;            // sessionId source OU '__center__' (hub)
  to: string;              // sessionId destinataire OU '__center__'
  kind: 'intra' | 'cross' | 'human' | 'broadcast';
  ts: number;              // ms epoch — utilisé pour dedupe 200 ms (Step 6 §5.5)
}
```

Mapping `kind` → classe CSS (Step 15 — clarification finale) :

| `kind`      | className                         | Couleur     | Animation   |
|-------------|-----------------------------------|-------------|-------------|
| `intra`     | `pulse-dot`                       | amber       | 1400 ms     |
| `cross`     | `pulse-dot`                       | amber       | 1400 ms     |
| `human`     | `pulse-dot human`                 | text (crème)| 1400 ms     |
| `broadcast` | `pulse-dot broadcast`             | amber + glow+ | **1800 ms** |

Rayon : `r=2.4` pour intra/cross/human, `r=2.8` pour broadcast (cf.
`v2/map.jsx:361`).

---

## 4. Génération `offset-path` dynamique

Au render, pour chaque `pulse` dans la prop `pulses: readonly MapPulse[]`
de `MapView`, on résout `from` / `to` en coordonnées SVG via le
`positions` map (issu de `layoutTeams(teams)`), puis on construit le path
SVG via `curveBetween(from, to, 0.10)` (helper Step 2). Le résultat
alimente `style.offsetPath`.

### 4.1 Code exact (port littéral de `v2/map.jsx:351-368`)

```tsx
// Dans MapView.tsx, sous-bloc <g> des pulses :
{pulses.map((p) => {
  const from = p.from === '__center__' ? CENTER : positions[p.from];
  const to   = p.to   === '__center__' ? CENTER : positions[p.to];
  if (!from || !to) return null;        // node disparu entre tick et render

  const kind = p.kind;
  const cls =
    `pulse-dot ${kind === 'human' ? 'human'
               : kind === 'broadcast' ? 'broadcast' : ''}`;

  const pathD = curveBetween(from, to, 0.10);
  const duration = kind === 'broadcast' ? '1800ms' : '1400ms';

  const style: CSSProperties = {
    offsetPath: `path("${pathD}")`,
    animation:  `pulse-travel ${duration} linear forwards`,
  };

  return (
    <circle
      key={p.id}
      className={cls}
      r={kind === 'broadcast' ? 2.8 : 2.4}
      style={style}
    />
  );
})}
```

### 4.2 Pourquoi `curveBetween(_, _, 0.10)` exact

Le curve factor `0.10` est **identique** à celui des `teamEdges` (lead↔
worker) dans `MapView` (Step 6 §9, ligne `curveBetween(e.a, e.b, 0.10)`).
Conséquence : le pulse suit exactement la courbe d'edge dessinée — c'est
le coeur du rendu "le pulse voyage sur l'edge". Pour `leadLinks` (hub↔
lead) l'edge utilise `0.04` (presque rectiligne) — mais les pulses
hub→agent (kind human/cross/broadcast) utilisent quand même `0.10`, ce
qui donne un léger décalage visuel (~ 5 pixels au milieu de la courbe).
**Décision** : on garde le mismatch (port fidèle du proto) ; il est
imperceptible à l'œil pour la durée 1.4 s.

### 4.3 Pourquoi `offset-path` plutôt qu'un `<animateMotion>` SVG

- `offset-path` est une animation **CSS** standardisée (Chrome 55+, FF
  72+, Safari 16+). Le mécanisme `<animateMotion>` SVG est legacy SMIL
  (deprecated par Chrome, supporté mais découragé).
- Avec CSS, on bénéficie de `prefers-reduced-motion` (à ajouter — cf.
  §10 risque) et du GPU compositing du compositeur navigateur.
- On garde React idiomatique : le `<circle>` est un noeud JSX standard,
  pas un noeud `<animateMotion>` qui demanderait `key` + `begin="0s"`.

### 4.4 Compatibilité navigateur

- Chrome / Edge (Chromium) ≥ 55 (2016) : OK natif.
- Firefox ≥ 72 (2020) : OK natif.
- Safari ≥ 16 (sept 2022) : OK natif. **Avant 16 → pas de support**.
  Acceptable : la cible desktop de Swarm OS est Chrome / Firefox récents
  (l'app tourne en Docker, on contrôle l'env). Pour macOS legacy on aurait
  un fallback statique (le `<circle>` est rendu mais immobile) — pas un
  blocker v1.

---

## 5. Lifecycle d'un pulse

### 5.1 Création

**Trigger** : un frame WS `mailbox.message` arrive sur `/ws/events`. Le
`DesktopShell` (Step 6 §9.1) a un callback enregistré via
`useEvents({ onMailboxMessage })` qui :

1. Calcule `kind = deriveKind(ev)` (Step 6 §5.3).
2. Résout `from` / `to` (Step 6 §5.4).
3. Appelle `setPulses((prev) => pushPulse(prev, { from, to, kind, ts }, idFactory))`
   (Step 6 §5.5 — dedupe 200 ms + cap 32 enforcés ici).

Au prochain render, React produit le `<circle>` dans le `<g>` des pulses
du SVG. L'animation **démarre automatiquement** au moment où le navigateur
applique le style `animation: pulse-travel … forwards` (frame suivante
après le `setState`). Pas d'`onMount` JS, pas de `getBoundingClientRect`,
pas de `requestAnimationFrame`.

### 5.2 Removal — pattern "cleanup différé" (port du proto)

Le proto **ne** retire **pas** les `<circle>` via `onAnimationEnd`. Il
les laisse dans le DOM jusqu'à ce que :

- le compteur dépasse 32 (cap) → `slice(Math.max(0, p.length - 32))`
  élimine les plus anciens ;
- **et/ou** le `setTimeout(1500)` (Step 6 §5.5) trunc à la dernière
  fenêtre cap-32 au prochain repos.

Conséquence visuelle : un pulse arrivé à `offset-distance: 100%` reste à
ce dernier point (`animation-fill-mode: forwards`) mais avec `opacity: 0`
(dernière keyframe), donc invisible. Il occupe un slot dans le `<g>` SVG
mais n'a aucun coût de rendu (Chrome skip l'élément 0-opacity du paint).

### 5.3 Pourquoi pas `onAnimationEnd` ?

**Option discutée mais rejetée** : ajouter `onAnimationEnd={() =>
setPulses(p => p.filter(x => x.id !== pulse.id))}` à chaque `<circle>`.

Raisons du rejet :

1. **Burst safety** : sur un `team.broadcast(20)` en < 200 ms, le dedupe
   du Step 6 §5.5 drop déjà la plupart des doublons. Le cap 32 + cleanup
   1500 ms est plus simple et idempotent — pas de risque de race entre
   N `setState` concurrents (chaque `onAnimationEnd` déclencherait un
   render).
2. **Coût des handlers** : 32 callbacks JS attachés en permanence ⇒
   32 closures stockées par React. Le pattern proto a 0 handler.
3. **Conformité au proto** : Step 15 = port fidèle. Pas d'écart sauf
   justification forte.

**Si on voulait quand même `onAnimationEnd`** (option de raffinement v2),
ce serait :

```tsx
<circle
  key={p.id}
  className={cls}
  r={kind === 'broadcast' ? 2.8 : 2.4}
  style={style}
  onAnimationEnd={() => removePulse(p.id)}
/>
```

avec `removePulse` qui fait `setPulses(p => p.filter(x => x.id !== id))`.
Pas pour Step 15 — laisser comme dette si la mémoire DOM devient un
problème observé.

### 5.4 Diagramme de vie

```
t=0ms   │ mailbox.message arrive
        │   → onMailboxMessage → pushPulse → setPulses
        │
t≈16ms  │ React render : <circle> apparaît dans le <g> pulses
        │   animation pulse-travel démarre (0% offset-distance, opacity 0)
        │
t≈140ms │ 10% de l'anim : opacity 1, offset-distance 10%
        │
t≈1260ms│ 90% de l'anim : opacity 1, offset-distance 90%
        │
t≈1400ms│ Fin de l'anim : offset-distance 100%, opacity 0
        │   (1800ms pour kind=broadcast)
        │   animation-fill-mode: forwards → reste à 100%/opacity 0
        │
t≈1500ms│ cleanup setTimeout déclenche slice(-32)
        │   → si > 32 pulses, les plus anciens retirés du DOM
        │
        │ Si nouveaux pulses arrivent avant 1500ms, le timer est reset
        │ (cf. effect cleanup dans Step 6 §5.5).
```

---

## 6. Cap 32 + dedupe 200 ms (rappel minimal Step 6)

**Spec définie Step 6 §5.5** — Step 15 ne réinvente rien.

- `PULSE_CAP = 32` : `setPulses` slice à la dernière fenêtre 32 dès qu'on
  pousse au-delà (drop FIFO des plus anciens) → tolère ~22 messages/s
  soutenus (32 / 1.4 s).
- `PULSE_DEDUPE_MS = 200` : dans `pushPulse`, walk backwards depuis le
  tail ; si on trouve un pulse `(from, to, kind)` identique dans les
  derniers 200 ms, on **drop** le nouveau (return prev). Évite la
  sur-densité quand `team.broadcast(N)` génère N events dans la même
  milliseconde.
- Cleanup différé : `setTimeout(1500)` dans un `useEffect([pulses])`
  trunc à `PULSE_CAP` au repos → libère le DOM des pulses morts (forwards
  les garde sinon en place avec opacity 0).

→ **Aucun changement Step 15**. Voir Step 6 §5.5 pour les unit tests
de `pushPulse`.

---

## 7. Rendering MapView — emplacement exact

Le bloc pulses est l'un des **5 sous-groupes** du `<svg className="canvas-svg">`,
dans cet ordre Z-axis (du fond vers l'avant) :

```tsx
<svg className="canvas-svg" viewBox={…}>
  <defs>… (hub-glow gradient)</defs>
  <circle … r={420} fill="url(#hub-glow)" />   {/* aura du hub */}
  <g>{leadLinks/teamEdges/intraEdges}</g>      {/* (1) edges */}
  <g>{pulses.map(...)}</g>                     {/* (2) pulses — STEP 15 */}
  <g className="center-hub">…</g>              {/* (3) hub */}
  <g>{teams.map(team => <Node …/>)}</g>        {/* (4) nodes */}
</svg>
```

**Ordre justifié** : les pulses passent **par-dessus** les edges (sinon
ils sont invisibles, masqués par les edges ambres) mais **sous** les
nodes et le hub (sinon ils passeraient bizarrement par-dessus le label
"SWARM // BUS" et les badges inbox). Le proto met les pulses entre edges
et hub — port littéral.

Le `<g>` parent des pulses **n'a pas de className** (pas besoin —
chaque `.pulse-dot` est self-styled).

```tsx
<g>
  {pulses.map((p) => {
    const from = p.from === '__center__' ? CENTER : positions[p.from];
    const to   = p.to   === '__center__' ? CENTER : positions[p.to];
    if (!from || !to) return null;
    const kind = p.kind;
    const cls = `pulse-dot ${kind === 'human' ? 'human' : kind === 'broadcast' ? 'broadcast' : ''}`;
    const style: CSSProperties = {
      offsetPath: `path("${curveBetween(from, to, 0.10)}")`,
      animation: `pulse-travel ${kind === 'broadcast' ? '1800ms' : '1400ms'} linear forwards`,
    };
    return <circle key={p.id} className={cls} r={kind === 'broadcast' ? 2.8 : 2.4} style={style} />;
  })}
</g>
```

C'est **strictement** ce qu'a déjà documenté Step 6 §9. Step 15 confirme
qu'aucun ajustement n'est nécessaire.

### 7.1 Type TypeScript pour `offsetPath`

`React.CSSProperties` inclut déjà `offsetPath?: string | undefined` depuis
les types DOM standard (lib.dom.d.ts > CSSStyleDeclaration). **Aucun
cast** nécessaire :

```ts
const style: React.CSSProperties = {
  offsetPath: `path("M 100 100 Q 200 50 300 100")`,
  animation:  'pulse-travel 1400ms linear forwards',
};
```

Vite/TS 5.7 compile sans warning. Si jamais le typecheck rouspète (vieux
TS), fallback : `style={{ offsetPath: '…' } as React.CSSProperties}`.

---

## 8. Plan d'implémentation pas-à-pas

Step 15 = **vérification + activation** (la quasi-totalité du code a été
livrée Step 6). Si Step 6 est en place, Step 15 se résume aux 4 contrôles
ci-dessous.

1. **Vérifier `desktop-theme.css`** (Step 1) contient bien :
   - `@keyframes pulse-travel { from … to … }` (cf. §2.1) ;
   - `.pulse-dot`, `.pulse-dot.human`, `.pulse-dot.broadcast` (cf. §2.2).

   ```sh
   grep -nE "@keyframes pulse-travel|\.pulse-dot" \
     packages/web/src/styles/desktop-theme.css
   ```

   → doit retourner ≥ 4 lignes (1 keyframes + 3 classes).
   Si absent → revenir au Step 1 §3.5 / §3.4 et re-copier le bloc
   `prototypes/v2/Swarm OS v2.html` lignes 389-394 + 719-721.

2. **Vérifier `MapView.tsx`** (Step 2/6) contient bien le bloc
   `{pulses.map(...)}` avec `style.offsetPath` et `style.animation`.

   ```sh
   grep -n "offsetPath" packages/web/src/components/desktop/MapView.tsx
   ```

   → doit retourner 1 ligne (cf. §7 ci-dessus). Si absent, recopier le
   bloc §4.1 (10 lignes JSX). Doit appeler `curveBetween(from, to, 0.10)`.

3. **Vérifier `DesktopShell.tsx`** câble bien `useEvents({ onMailboxMessage })`
   (Step 6 §9.1) et passe `pulses` à `<MapView />` :

   ```sh
   grep -nE "onMailboxMessage|setPulses|pulses=" \
     packages/web/src/components/desktop/DesktopShell.tsx
   ```

   → doit retourner ≥ 3 lignes.

4. **Vérifier `useEvents.ts`** expose le callback (Step 6 §5.2) :

   ```sh
   grep -n "onMailboxMessage" packages/web/src/hooks/useEvents.ts
   ```

   → doit retourner ≥ 2 lignes (interface + invocation).

Si les 4 vérifs passent : **Step 15 est livré** — c'est uniquement un
vivisection visuelle. Sinon, retour aux Steps 1 / 6 pour combler
l'élément manquant.

### 8.1 Aucun nouveau fichier à créer pour Step 15

Récapitulatif diff vs Step 6 :

| Fichier | Action Step 15 |
|---|---|
| `desktop-theme.css` | vérifier présence keyframes + classes (Step 1) |
| `MapView.tsx` | vérifier bloc pulses (Step 6 §9) |
| `pulses.ts` | aucun changement (Step 6 §5) |
| `DesktopShell.tsx` | aucun changement (Step 6 §9.1) |
| `useEvents.ts` | aucun changement (Step 6 §5.2) |
| `prefers-reduced-motion` | **optionnel** — ajouter en `desktop-theme.css` (cf. §10) |

---

## 9. Tests de fumée

À exécuter après docker rebuild (cf. mémoire `project_docker_redeploy.md` :
`docker build -t swarm-os:latest . && docker compose -f docker-compose.test.yml up -d`),
ouvrir `http://127.0.0.1:8080/` (ou port mappé) :

| # | Geste | Attendu visuel |
|---|---|---|
| 1 | Ouvrir l'app au repos (aucun pulse) | `<g>` pulses contient 0 `<circle>` — DevTools Elements |
| 2 | Créer 1 orchestrator avec 2 workers ; envoyer message intra (`team.send_message` MCP) | 1 pulse ambre voyage du lead vers le worker en ~1.4 s, le long de la courbe d'edge — visible à l'oeil |
| 3 | Operator broadcast à un orch (`POST /orchestrators/:id/broadcast`) | N pulses crème (`pulse-dot human`) voyagent du hub central vers chaque session, en ~1.4 s |
| 4 | Cross-team `swarm.send_to_lead` (FORGE → ATLAS) | 1 pulse ambre voyage du hub vers le lead ATLAS (origine `__center__`, donc visuellement identique à human mais ambre) |
| 5 | Hub-broadcast (clic sur le hub, BroadcastModal Phase C → boucle N broadcasts) | N pulses ambre **broadcast** (`.pulse-dot.broadcast`, r=2.8, glow 6px) voyagent du hub vers chaque session ; durée 1.8 s (visiblement plus lent que les autres) |
| 6 | Spam `team.broadcast(20×)` en < 200 ms | Dedupe Step 6 → max ~5 pulses visibles (dedupe + cap 32). Pas de saccade, pas de freeze |
| 7 | Maintenir un trafic soutenu (~10 msg/s pendant 30 s) | Cap 32 enforce ; le `<g>` pulses contient toujours ≤ 32 enfants. DevTools Performance : pas de spike GC |
| 8 | DevTools → Elements → inspecter un `<circle class="pulse-dot">` pendant l'animation | `style="offset-path: path(\"M 600 130 Q …\"); animation: pulse-travel 1400ms linear forwards"`. Le `offsetDistance` calculé varie de 0% à 100% au cours de l'anim (visible dans le panel Computed) |
| 9 | DevTools → Performance → enregistrer 5 s avec trafic | Pas de long task > 50 ms causée par les pulses. Le compositor thread gère l'animation, pas le main thread (animation "composited" cf. Chrome Layers panel) |
| 10 | Naviguer `#/` ↔ `#/roles` puis revenir | Pas de pulse zombie après remount ; `<g>` repart de 0. Pas de leak WS (déjà fixé par commit 584d9ec) |
| 11 | Activer `prefers-reduced-motion` (OS-level ou DevTools → Rendering → Emulate CSS prefers-reduced-motion: reduce) | Si la règle media de §10 est ajoutée : pulses statiques ou désactivés. Sinon (Step 15 v1 strict) : pulses continuent normalement |
| 12 | Stopper un orchestrator pendant qu'un pulse est en vol | Le pulse en cours d'anim continue (anim CSS découplée du state React). Le node disparaît à la fin de l'anim au cleanup |
| 13 | Resize la fenêtre (changer la largeur de la MapView) | Les paths sont recalculés au prochain render des nouveaux pulses (positions changent via `layoutTeams` → `curveBetween`). Les pulses **déjà en vol** restent sur leur path original — léger artefact visuel acceptable |
| 14 | Zoom+ / zoom- sur la map | Les pulses zooment avec le SVG (viewBox-based) ; pas de discontinuité |

### 9.1 Critères d'acceptation

- [ ] Au moins 1 pulse intra/cross/human/broadcast a été observé visuellement
      en condition réelle (frame `mailbox.message` du serveur).
- [ ] DevTools Elements : `<circle class="pulse-dot …" style="offset-path: path(\"…\"); animation: pulse-travel … linear forwards">`
      visible pendant ≈ 1.4 s puis disparaît du DOM dans les 1.5 s suivantes.
- [ ] Sous trafic soutenu (10 msg/s, 60 s) : aucune perte de FPS dans la
      MapView (DevTools FPS meter > 55).
- [ ] Cap 32 vérifiable : `document.querySelectorAll('.pulse-dot').length ≤ 32`
      à tout moment.

---

## 10. Risques & dette

1. **`prefers-reduced-motion` non géré** : le proto v2 ne wrap **aucun**
   keyframes (`pulse-travel`, `pulse-fade`, `ring-pulse`, `flash-new`,
   `node-spawn`, `modal-in`, `drawer-in`, `toast-in`, `backdrop-in`)
   derrière un media query reduced-motion. Step 15 v1 = port fidèle, on
   accepte la dette. **Mitigation suggérée** (à ajouter en tête ou pied
   de `desktop-theme.css`) :

   ```css
   @media (prefers-reduced-motion: reduce) {
     .pulse-dot { animation: none !important; opacity: 0; }
     /* … et idem pour les autres animations cosmétiques … */
   }
   ```

   À traiter en passe d'accessibilité ultérieure (déjà tracké en Step 1
   §6.9).

2. **Safari < 16** : `offset-path` n'est pas supporté. Les `<circle>`
   apparaissent à `cx=0, cy=0` (origine SVG) sans animer. **Mitigation**
   : aucune pour v1 — l'app cible des navigateurs récents. Si jamais on
   doit supporter macOS Catalina, fallback = `<animateMotion>` SMIL (à
   investiguer).

3. **Backlog DOM en cas de Safari freeze** : si le `setTimeout(1500)` ne
   se déclenche pas (onglet en background), le `<g>` pulses peut
   accumuler au-delà de 32 jusqu'au prochain push. Le push lui-même
   appelle `slice(-32)` (Step 6 §5.5 `pushPulse`), donc l'invariant 32
   tient toujours **au push**. Le cleanup 1500 ms est une optim, pas une
   garantie de borne. RAS pour la mémoire DOM.

4. **`offset-path` ne réagit pas aux changements de prop** : si on
   `setState(pulses)` avec un même `id` mais un `from`/`to` différent,
   React update le `style` mais le navigateur **ne** redémarre **pas**
   l'animation (déjà en cours sur l'ancien path → comportement implementation-defined).
   **Mitigation** : on n'update jamais un pulse — chaque push crée un
   `id` neuf via `pulseIdRef.current++`. Garantie par Step 6 §5.5. RAS.

5. **Z-order vs hub label** : si le hub label "SWARM // BUS" passe par-
   dessus une zone où un pulse arrive (`to === '__center__'`), le pulse
   peut sembler "disparaître" derrière le label. Acceptable visuellement
   (le label est petit et le pulse fade-out à 100 % de toute façon).

6. **Pulses qui pointent vers des sessions disparues entre tick et
   render** : `if (!from || !to) return null` ne crée pas le `<circle>`.
   Le pulse est silencieusement skip. Pas de crash, pas de console warn.
   Acceptable.

---

## 11. Références croisées

- Plan global : `/home/ubuntu/projets/swarm-os/docs/internal/ui-redesign/ui-redesign-desktop.md`
  - §3.3 (MapView mapping, ligne "Pulses 4 kinds")
  - §5.1 step 15 (Phase D — pulses animés)
  - §5.4 risque #2 (cap 32 + perf)
- Step 1 (Phase A.1) : `01_design-system-v2.md` §3.5 (extraits CSS
  pulse-travel + pulse-dot)
- Step 2 (Phase A.2) : `02_desktop-skeleton.md` §2 (création
  `MapView.tsx`, `curveBetween.ts`, `layoutTeams.ts`)
- **Step 6 (Phase B.6)** : `06_mapview-data-binding.md` §5 (pipeline
  pulses complet — `MapPulse`, `deriveKind`, `pushPulse`, dedupe 200 ms,
  cap 32, cleanup différé, callback `onMailboxMessage`), §9 (bloc JSX
  pulses dans MapView.tsx)
- Source de vérité visuelle :
  - `/home/ubuntu/projets/swarm-os/prototypes/v2/map.jsx:351-368` (bloc
    JSX `<circle>` pulses)
  - `/home/ubuntu/projets/swarm-os/prototypes/v2/Swarm OS v2.html`
    lignes 389-394 (keyframes), 719-721 (classes)
  - `/home/ubuntu/projets/swarm-os/prototypes/v2/app.jsx:140,156-263`
    (state `pulses`, `pulseIdRef`, cleanup 1500 ms, génération démo)
