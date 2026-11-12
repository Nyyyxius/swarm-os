# S7 — Champ `health` agrégé au niveau orchestrator

> Analyse d'implémentation détaillée pour le chantier S7 décrit dans
> `docs/internal/ui-redesign/update_system.md` (lignes 140-156).

---

## 1. Résumé du besoin

La nouvelle TopBar affiche par team une pastille `HEALTHY / DEGRADED /
OFFLINE` (`prototypes/app.jsx:48-66`) qui dépend d'un champ logique
`health ∈ {ok, warn, bad, stopped}` agrégé du statut orch, du statut
lead, des statuts workers et de `lastError`.

Aujourd'hui le serveur expose tout le matériau brut mais pas le verdict
agrégé. S7 formalise ce calcul comme champ dérivé de `OrchestratorView`
(re-sérialisé à chaque `toView()`), purement en mémoire — évite la
divergence front/back et donne un nom canonique réutilisé par TopBar,
LeftPanel, MapView. Aucune persistance, aucun nouvel event, aucune
migration.

## 2. État actuel

### Côté serveur

- `OrchestratorView` (`packages/server/src/modules/orchestrator/index.ts:35-53`)
  contient déjà tout ce qu'il faut :
  - `status: OrchestratorStatus` (`'starting' | 'running' | 'stopping' |
    'stopped' | 'failed'`, ligne 16).
  - `leadSessionId: string | null`.
  - `lastError: string | null` (ligne 49).
  - `sessions: SessionView[]` (ligne 50) — donc chaque worker avec son
    `status: SessionStatus`.
- `SessionStatus` (`session.ts:22-29`) :
  `'starting' | 'running' | 'waiting' | 'exited' | 'killed' |
  'interrupted' | 'failed'`. **Pas (encore) de `paused`** — sera ajouté
  par S5.
- Méthode `Orchestrator.toView()` (`index.ts:403-422`) — un seul point
  de sortie pour les serializations REST (`GET /orchestrators`,
  `GET /orchestrators/:id`, `POST /orchestrators`) — voir
  `packages/server/src/http/routes/orchestrators.ts:193`. **C'est ici
  qu'il faut greffer le champ `health`**.
- Identification du lead : helper `_isActive` (`index.ts:426-428`)
  considère `running|starting|waiting` comme actifs. Le getter
  `lead: Session | null` (`index.ts:391-393`) résout proprement le lead
  depuis `_leadSessionId`.

### Côté client

- Mirror `OrchestratorView` (`packages/web/src/api/client.ts:15-33`) —
  union `status` identique à la version serveur. Champ `lastError`
  présent (ligne 29). Champ `sessions: SessionView[]` (ligne 30).
- `SessionStatus` mirror (`client.ts:68`) — même union serveur.
- Consommateurs : `useOrchestrators` (`hooks/useOrchestrators.ts`),
  `OrchestratorList`, `OrchestratorView.tsx`. Aucun ne calcule encore
  de `health` — le besoin n'est porté que par la **nouvelle** UI desktop
  (cf. proto). Donc S7 ajoute un champ qui n'a actuellement **aucun
  consommateur** côté code prod ; il est consommé par `prototypes/app.jsx`
  qui n'est pas un client réel.

### Persistence et autres consommateurs

- `rowToOrchView()` (`persistence.ts:167-189`) rehydrate des rows
  d'orchestrators **terminés** (`status ∈ {stopped, failed}`). Comme
  `health` est dérivé, on peut renvoyer `'stopped'` (ou `'bad'` si
  `status === 'failed'`) en dur — pas besoin de relire les sessions.
- `notify/index.ts:29-41` importe `OrchestratorView` pour typer les
  notifs ; ne lit pas `health`. Aucun impact.
- `prototypes/app.jsx:48-53` est le seul code qui consomme `health`
  aujourd'hui (en local sur données simulées) — référence
  comportementale.

## 3. Fichiers à modifier

**Serveur** :

- `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/index.ts`
  - Ajouter le type `OrchestratorHealth = 'ok' | 'warn' | 'bad' | 'stopped'`.
  - Ajouter `health: OrchestratorHealth` à l'interface `OrchestratorView`.
  - Implémenter `computeOrchestratorHealth(view)` (fonction pure
    exportée, prenant un `Pick<OrchestratorView, 'status' | 'leadSessionId'
    | 'lastError' | 'sessions'>`).
  - Brancher dans `toView()` : `health: computeOrchestratorHealth(viewSansHealth)`.
- `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/persistence.ts`
  - Dans `rowToOrchView()`, ajouter `health: 'stopped'` (les rows DB
    sont des orchestrators historiques terminés). Alternative :
    `health: computeOrchestratorHealth({status: row.status, ...})` si
    on veut être strict — mais comme `status` est forcément terminal
    on ne perd rien à hardcoder `'stopped'`.

**Tests serveur** :

- `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/health.test.ts`
  (nouveau) — tests table-driven de `computeOrchestratorHealth`.

**Client** :

- `/home/ubuntu/projets/swarm-os/packages/web/src/api/client.ts`
  - Ajouter `health: 'ok' | 'warn' | 'bad' | 'stopped'` à `OrchestratorView`.
  - Marquer **non-optionnel** une fois S7 livré (les rows histo
    renvoient `'stopped'`). Si rollout progressif, le marquer `?:` puis
    durcir.

**Pas de modification** :

- `events.ts` : aucun event `orchestrator.health_changed` requis — le
  front lit `health` à chaque `orchestrator.updated` ou poll REST 3 s.
- DB migrations : aucune.
- `notify/index.ts` : utilise le statut brut, pas `health`.

## 4. Plan d'implémentation

### 4.1 Type

```ts
export type OrchestratorHealth = 'ok' | 'warn' | 'bad' | 'stopped';
```

### 4.2 Fonction pure

Signature volontairement minimale (entrée = `Pick` du `OrchestratorView`)
pour rester appelable depuis n'importe quel call-site : `toView()`,
`rowToOrchView()`, tests, et même éventuellement le client si on
revenait sur la décision serveur.

```ts
type HealthInput = Pick<
  OrchestratorView,
  'status' | 'leadSessionId' | 'lastError' | 'sessions'
>;

export function computeOrchestratorHealth(v: HealthInput): OrchestratorHealth {
  // 1. Cycles terminaux non-vivants
  if (v.status === 'stopped' || v.status === 'stopping') return 'stopped';
  if (v.status === 'failed') return 'bad';

  // 2. Trouver le lead (peut ne pas exister en phase starting)
  const lead = v.leadSessionId
    ? v.sessions.find((s) => s.id === v.leadSessionId) ?? null
    : null;

  // 3. Lead failed → bad (règle explicite spec)
  if (lead?.status === 'failed') return 'bad';

  // 4. Warn : lead waiting | lastError non null | ≥1 worker failed
  if (lead?.status === 'waiting') return 'warn';
  if (v.lastError != null) return 'warn';
  const workers = v.sessions.filter((s) => s.type === 'worker');
  if (workers.some((s) => s.status === 'failed')) return 'warn';

  // 5. ok = lead running + tous workers vivants en running
  //    (les workers terminés normalement — exited|killed|interrupted —
  //    ne dégradent PAS le health : leur cycle de vie est légitime.)
  return 'ok';
}
```

### 4.3 Branchement

```ts
toView(): OrchestratorView {
  const sessions = this.listSessions().map((s) => s.toView());
  const base = {
    id: this.id,
    /* ...comme aujourd'hui... */
    sessions,
  };
  return { ...base, health: computeOrchestratorHealth(base) };
}
```

Coût ≈ une boucle linéaire sur la liste sessions à chaque sérialisation.
Pas de cache nécessaire — N est ≤ `maxWorkersPerOrch` (typiquement 8).

### 4.4 Pureté & testabilité

La fonction n'accède ni à `Date.now()`, ni à `eventBus`, ni au DOM. Elle
prend un objet figé et renvoie un littéral. → couvrable à 100 % par une
table de cas.

## 5. Tableau de transitions

Cas couverts par la règle textuelle (`update_system.md:147-152`) :

| # | Statut orch | Statut lead | Workers (résumé) | lastError | → health |
|---|---|---|---|---|---|
| 1 | running | running | tous running | null | **ok** |
| 2 | running | running | tous running | non null | **warn** |
| 3 | running | running | ≥1 failed | null | **warn** |
| 4 | running | waiting | tous running | null | **warn** |
| 5 | running | failed | n/a | n/a | **bad** |
| 6 | stopped | * | * | * | **stopped** |
| 7 | failed | * | * | * | **bad** |
| 8 | stopping | * | * | * | **stopped** (déduit — orch en cours de teardown) |

Cas implicites (à expliciter dans cette analyse) :

| # | Cas | → health | Justification |
|---|---|---|---|
| 9 | `status=starting`, pas encore de lead | **ok** (par défaut) | Période transitoire. Si le spawn échoue, on bascule vite en `failed`/`bad`. Pas de raison d'afficher `warn` pour ~150 ms. |
| 10 | Lead `running`, ≥1 worker `waiting` | **ok** | "lead waiting" est warn (signal opérateur) ; **"worker waiting" ne dégrade pas le health agrégé** — un worker peut légitimement attendre que son lead lui parle. Cohérent avec S3 qui pulse le worker mais ne déclenche pas de toast bus. |
| 11 | Lead `running`, worker `exited`/`killed`/`interrupted` (terminé proprement) | **ok** | Un worker qui a fini son job ne doit pas faire passer la team en `DEGRADED`. La liste `sessions` conserve les terminés. |
| 12 | Lead `running`, worker `starting` | **ok** | Worker en cours de spawn. Court par nature. |
| 13 | Lead `running`, worker `failed` ET orch `running` ET `lastError` null | **warn** | Le spawn d'un worker peut échouer sans tuer la team (cf. `WorkerCapError` côté MCP). |
| 14 | `paused` worker (post-S5) | **ok** (proposé) | `paused` = action volontaire opérateur, pas une anomalie. Doit être traité comme "non-failed, non-waiting" → n'influence pas `health`. **À acter avec S5.** |
| 15 | Lead `running`, **deux** signaux warn simultanés (worker failed + lastError) | **warn** | `warn` est terminal pour les conditions warn — pas de `warn+`. |
| 16 | Lead disparu (`leadSessionId === null` et `status === 'running'`) | **bad** (en théorie inatteignable) | Cohérence : un orch sans lead est une anomalie structurelle. Le code défensif renvoie `'bad'` via le branch « pas de lead trouvé + status running » — facultatif ; on peut aussi laisser tomber dans le `return 'ok'` final et compter sur le fait que le status passe `failed` immédiatement. |

**Priorités** (en cas de collision) : `bad > warn > ok`. La règle de la
spec est déjà disjointe (`stopped` testé d'abord, puis `bad`, puis `warn`,
puis `ok`).

## 6. Tests à écrire

`packages/server/src/modules/orchestrator/health.test.ts` (nouveau) —
suite Vitest table-driven, mocks zéro, objets `HealthInput` littéraux.
Couvrir au moins :

1. all-running → `ok`
2. lead `waiting` → `warn`
3. ≥1 worker `failed` → `warn`
4. `lastError` non null → `warn`
5. lead `failed` → `bad`
6. orch `stopped` → `stopped`
7. orch `failed` → `bad`
8. orch `stopping` → `stopped`
9. `starting`, pas de lead encore → `ok`
10. worker `waiting` (lead running) → `ok`
11. worker `exited` proprement → `ok`
12. worker `starting` (lead running) → `ok`
13. `lastError` + worker `failed` → `warn` (idempotent)
14. lead `failed` + `lastError` → `bad` (lead l'emporte)

Test d'intégration (dans `orchestrator.test.ts` ou route test) :
créer orch (skipSpawn) → `health: 'ok'` ; `destroyOrchestrator` →
`health: 'stopped'`.

## 7. Gotchas

- **`lead waiting` = warn ; `worker waiting` n'élève pas le verdict.**
  La spec (`update_system.md:150`) parle explicitement du lead.
  S'aligner sur S3 : `waiting` worker → pulsation locale, pas
  d'escalade team.
- **Cohérence S3/S6/S7.** S3 fige le mapping visuel par session. S6
  (idle frontend-only) ne crée pas de `SessionStatus` `idle` côté
  serveur → S7 n'a pas à connaître `idle`.
- **S5 et `paused`.** Quand S5 atterrit, `SessionStatus` gagnera
  `paused`. Par défaut `paused` n'est pas `failed` ni `waiting` → tombe
  dans `ok`. À expliciter dans la PR S5 (commentaire dédié dans
  `computeOrchestratorHealth`).
- **`stopping` vs `stopped`.** Spec ne mentionne que `stopped`. Cette
  analyse les regroupe sous `'stopped'` côté `health` — team déjà non
  opérationnelle. Décision réversible.
- **Lead non encore résolu** (`leadSessionId === null` + `status =
  'starting'`) : renvoyer `'ok'` (fenêtre courte, évite le flicker
  `DEGRADED → HEALTHY`).
- **Performance.** N ≤ 8 typique, ≤ 32 cap. O(N) à chaque `toView()`,
  pas de cache requis.
- **Stabilité de la sérialisation.** Ajout additif (cf.
  `update_system.md:289-306`) — anciens clients ignorent le champ.

## 8. Dépendances

- **S3** (mapping `waiting`) : aucune dépendance technique mais S7
  consomme implicitement la sémantique « lead waiting = signal critique »
  qui est figée par S3.
- **S5** (`paused`) : S7 doit savoir que `paused` ∉ `{warn, bad}`. Pas
  bloquant si livré avant S5, mais on devra mettre à jour S7 quand S5
  arrive (ajout d'un commentaire suffit).
- **S6** (`idle`) : si S6 reste frontend-only (recommandé), S7 n'a rien
  à faire. Si S6 v2 ajoute `idle` côté serveur, S7 doit le traiter
  comme `running`.

**Ordre conseillé** : livrer S3, S5, S6 avant S7 — l'enum
`SessionStatus` sera alors stable et la table de cas définitive. Si on
veut livrer S7 plus tôt, c'est possible mais on retouchera la fonction
quand `paused` apparaîtra.

## 9. Critères d'acceptation

- [ ] Le type `OrchestratorHealth` est exporté depuis
      `packages/server/src/modules/orchestrator/index.ts`.
- [ ] La fonction `computeOrchestratorHealth(view)` est exportée et
      pure (aucun side effect, aucun accès `Date.now`).
- [ ] `Orchestrator.toView()` inclut `health` dans son retour.
- [ ] `GET /orchestrators` et `GET /orchestrators/:id` renvoient un
      champ `health` non-nul pour chaque orchestrator.
- [ ] `OrchestratorView` (client) est mis à jour avec le même champ.
- [ ] Suite de tests table-driven couvre **au moins** les 14 cas
      listés en §5, chacun avec un assert direct.
- [ ] Test d'intégration : un orch fraîchement créé renvoie
      `health: 'ok'` (en mode skipSpawn), un orch détruit renvoie
      `health: 'stopped'`.
- [ ] Aucun nouveau event, aucune nouvelle route, aucune migration DB.
- [ ] `rowToOrchView()` renvoie `health: 'stopped'` pour les rows
      historiques.
- [ ] `npm run build` + `npm test` passent sans warning de type.
