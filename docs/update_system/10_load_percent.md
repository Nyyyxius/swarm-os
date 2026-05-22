# S10 — Heuristique "load %" par session

> Analyse en profondeur du lot **S10** de `docs/update_system.md`
> (lignes 209-221). Lot trivial sur le plan code (0 ligne backend
> attendue) — l'enjeu est éditorial : décider ce qu'on affiche tant
> qu'aucune métrique fiable n'existe.

---

## 1. Résumé du besoin

Le prototype desktop affiche une stat-bar 3 cases dans le
`ProcessPanel` (`prototypes/panels.jsx:192-205`) ; la 1re case rend
**LOAD** sous forme de `%` calculé depuis le champ simulé
`selected.load` de `prototypes/data.jsx`. Idem mobile sheet
(`prototypes/mobile/mobile-sheets.jsx:95-108`). Côté production
aucune source de cette valeur n'existe. S10 tranche : **(a) afficher
`—` en v1**, ne pas inventer de chiffre. Options (b) débit PTY et
(c) CPU% via `/proc` reportées.

---

## 2. État du code existant

- **Prototype.** `selected.load` est un scalaire `0..1` codé en dur
  dans `prototypes/data.jsx` (lignes 19, 23-26, 44, 48-52, 70,
  74-76, 94, 98-99). Rendu via `Math.round((selected.load || 0) *
  100) + "%"` (`panels.jsx:194`, `mobile/mobile-sheets.jsx:97`).
  Mutations simulées dans `mobile/mobile-app.jsx` (start/stop/
  restart). Aucune base réelle.
- **Serveur.** `grep -rn "load\|cpu\|metric"
  packages/server/src/modules/orchestrator/` → 0 match pour une
  charge par session. `SessionView` (`session.ts:90-105`) expose
  `pid`, `status`, `startedAt`, `endedAt`, `exitCode` — **aucun
  champ `load`/`cpu`/`bytes`**. `OrchestratorView`
  (`orchestrator/index.ts:35`) idem. `/health` (`http/main.ts:
  69-79`) expose 4 compteurs ponctuels seulement.
- **UI prod.** `packages/web/src/components/OrchestratorView.tsx`
  n'affiche **pas encore** la stat-bar 3 cases — arrivera avec un
  lot UI ultérieur (`ui-redesign-desktop`). Aucun `LOAD`/`pr-stats`
  à corriger aujourd'hui.
- **PTY brut disponible.** `session.ts:193` tient un `ringBuffer`
  PTY pour xterm/replay. Mesure `bytes/sec` possible (option b)
  mais rien n'est instrumenté.

**Conclusion** : S10 v1 = **décision documentaire + garde-fou** pour
le lot UI futur. Rien à faire backend, rien à faire frontend tant
que la stat-bar n'est pas portée.

---

## 3. Décision recommandée : option (a) — afficher `—`

| Option | Coût impl. | Maint. | Valeur info | Risque |
|---|---|---|---|---|
| **(a) Élider (`—`)** | ~0 | ~0 | Honnête | Aucun |
| (b) Débit PTY norm. | M | M (calibrer max) | Faible (≠ charge) | Illusion d'une mesure |
| (c) CPU% via `/proc` | M-L | L (multi-thread, dead pids) | Bonne | ≥200 lignes pour gain UX faible |

Trois raisons font pencher vers (a) : (1) **aucune douleur UX
prouvée** — le `LOAD` du proto vient d'un design statique, aucun
user n'a réclamé ; (2) **mentir est pire que se taire** — un `62%`
qui sort de nulle part risque d'induire des décisions irréversibles
("session surchargée → kill") ; (3) **coût d'opportunité** — le
budget de (b)/(c) est mieux dépensé sur les vrais signaux (S2
pulses, S6 idle, S7 health).

**Sémantique du `—`** : déjà utilisé dans le proto pour
`UPTIME`/`PARENT` quand non applicable (`panels.jsx:198`,
`mobile-sheets.jsx:101`). Cohérent visuellement, muet sémantiquement.

---

## 4. Fichiers à modifier

**Backend** : aucun. **Frontend** : 1 fichier, le jour où la
stat-bar 3 cases est portée du proto à l'UI prod —
`packages/web/src/components/<futur ProcessPanel>.tsx` (probable
enrichissement de `OrchestratorView.tsx` ou nouveau
`SessionPanel.tsx`) : câbler la 1re case **en dur sur `—`** (U+2014),
pas de prop `load`, pas de hook, commentaire pointant vers ce doc.

Le proto (`prototypes/`) reste un mock visuel intact, hors-scope.

Pour option (b) v2 : `loadHint?: number` (pas `load`) à
`SessionView` + mesure dans `session.ts` + exposition via
`/orchestrators` (déjà polled). ~80 lignes. Hors scope v1.

---

## 5. Plan d'implémentation détaillé

### 5.1 Option (a) — implémentation v1

Trois étapes triviales **à appliquer lors du portage UI** (pas
maintenant, sauf si le même patch porte la stat-bar) :

1. Rendre `<div className="v">—</div>` au lieu de
   `Math.round((selected.load || 0) * 100) + "%"`.
2. **Ne pas** ajouter de champ `load` à `SessionView` /
   `OrchestratorView` côté serveur.
3. **Ne pas** créer de hook `useLoad()` côté web.

```tsx
{/* LOAD: see docs/update_system/10_load_percent.md — no source
    backend today; show `—`, never invent a number. */}
<div className="v">—</div>
<div className="k">LOAD</div>
```

**Total : ~3 lignes + ~15 lignes de tests.** Aucun backend.

### 5.2 Aperçu rapide option (b) — débit PTY (v2 si demandé)

1. Dans `session.ts`, à chaque event `data` PTY : `this._bytesSince
   Last += chunk.length`. Snapshot toutes les 30 s, reset.
2. Normalisation : `Session._maxRate` mis à jour avec plafond (ex.
   1 MiB/s) ; `loadHint = min(1, currentRate / max(_maxRate, threshold))`.
3. Exposition : `loadHint?: number` dans `SessionView`, polled via
   `/orchestrators` (déjà polled). Pas d'endpoint nouveau.
4. UI : `loadHint != null ? Math.round(loadHint * 100) + '%' : '—'`.

**Caveat** : le débit PTY mesure le volume textuel sorti, pas la
CPU. Un Claude qui réfléchit longtemps avant de cracher 200 lignes
aura un pic visible alors qu'il était silencieux. Label UX
`ACTIVITY`/`OUT`, **pas `LOAD`**.

### 5.3 Pourquoi pas option (c) maintenant

`/proc/<pid>/stat` est exact mais nécessite polling 5 s, gestion
des `pid` morts entre 2 polls, multi-thread (`proc/<pid>/task/*/
stat`). ≥200 lignes pour gain UX faible vs (a). Hors scope.

---

## 6. Tests à écrire

Tests de rendu UI au moment du portage `ProcessPanel`, dans
`packages/web/src/components/<NomDuPanneau>.test.tsx` :

| Cas | Attendu |
|---|---|
| Session `running` | Case `LOAD` rend exactement `—` (U+2014). |
| `stopped`/`exited`/`killed` | Idem `—`. |
| Session sans `pid` | Idem `—`. |
| DOM ne contient jamais `%` à proximité de `LOAD` | Régression-guard. |

```ts
const loadCell = screen.getByText(/LOAD/i).parentElement!;
expect(loadCell.textContent).toContain('—');
expect(loadCell.textContent).not.toContain('%');
```

**Pas** de test backend (aucun code backend ajouté).

---

## 7. Gotchas / pièges

- **Ne pas masquer l'absence de signal.** Éviter `Math.random() *
  100` ou le recyclage d'une métrique adjacente (uptime, msgCount,
  log.length) formatée en `%`. `—` est la **seule** valeur
  acceptable v1.
- **Ne pas inventer une fausse précision.** `62%` (proto) ou
  `bytes/sec / max` (option b naïve) suggère une résolution que la
  mesure n'a pas. (b) future = caveat UI ("activité sortante", pas
  "charge") **et** label différent (`ACTIVITY`/`OUT`, pas `LOAD`).
- **Em-dash strict.** Utiliser `—` (U+2014), pas `-` (U+002D
  hyphen). Cohérence avec `UPTIME`/`PARENT` du proto.
- **Ne pas toucher au proto.** `prototypes/` reste un mock visuel.
  La règle S10 ne s'applique **qu'à `packages/web/`**.
- **Si (b) un jour : ne pas s'appeler `load`.** Renommer en
  `outputRate`/`activity`. Le mot `load` sous-entend "charge CPU"
  et reste trompeur même mesuré proprement.

---

## 8. Dépendances avec d'autres lots

- **Aucune dépendance dure.** S10 est strictement indépendant.
- **Lien indirect.** Si la stat-bar du proto est portée à l'UI prod
  dans un lot UI ultérieur (`ui-redesign-desktop`), la décision S10
  s'y applique. Ce doc sert de référence à citer.
- **S6 (idle) et S7 (health)** apportent des signaux qualitatifs
  qui rendent un `LOAD: 62%` d'autant moins urgent : l'utilisateur a
  déjà des chips de status.

---

## 9. Critères d'acceptation vérifiables

1. **Aucun nouveau champ** `load`/`loadHint`/`cpuPct` dans
   `SessionView` (`session.ts:90`) ni `OrchestratorView`
   (`orchestrator/index.ts:35`).
2. **Aucun endpoint** `/metrics/load`, `/sessions/:id/load` ajouté.
3. **Aucun polling `/proc`** ni mesure bytes/sec PTY (`grep -rn
   "proc/.*stat\|_bytesSinceLast" packages/server/src/` → 0 match).
4. Si stat-bar portée dans le même patch : case `LOAD` rend `—`
   (U+2014) pour **toutes** les valeurs de `session.status`
   (`starting`/`running`/`waiting`/`exited`/`killed`/`interrupted`/
   `failed`).
5. Le composant ne contient pas `%` à proximité de `LOAD`
   (régression-guard).
6. Un commentaire pointe vers `docs/update_system/10_load_percent.md`.
7. Tests §6.1 verts. Pas de test backend nouveau.
8. `pnpm -w test && pnpm -w typecheck && pnpm -w lint` passent.
9. Proto (`prototypes/`) **non modifié** par ce lot.

---

## 10. Estimation d'effort et note finale

- Stat-bar non encore portée → **0 ligne** : S10 = ce doc +
  garde-fou pour le lot UI futur.
- Stat-bar portée dans le même patch → ~3 lignes + ~15 de tests
  (**~20 lignes nettes**). Classement **XS**.

S10 est le lot le plus court côté code mais pas le moins important :
il fixe une norme — **"ne pas afficher de chiffre sans source"**.
Le `LOAD: 62%` du proto est un mock, jamais une spec produit.
