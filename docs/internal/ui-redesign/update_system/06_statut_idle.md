# S6 — Statut session `idle` (détection)

> Analyse d'implémentation détaillée pour le chantier S6 décrit dans
> `docs/internal/ui-redesign/update_system.md` (lignes 122-138).

---

## 1. Résumé du besoin

Le prototype desktop distingue `running` (vert, agent actif) de
`idle` (gris clair, agent en vie mais silencieux). L'enum serveur
`SessionStatus` n'a **pas** de valeur `idle` — c'est un état
opérationnel **dérivé** de `lastActivityAt`. Deux options :

1. **Server-side** : tick de 5 s qui mute `running → idle` quand
   `now - lastActivityAt > 30 s`, émet `session.status_changed`.
2. **Frontend** : dériver `idle` en mémoire dans le composant
   d'affichage à partir du champ `lastActivityAt` déjà exposé.

`update_system.md:136-138` **recommande l'option 2 pour la v1**.
Cette analyse confirme et détaille ce choix.

## 2. État actuel

### Source de vérité : `lastActivityAt`

`packages/server/src/modules/orchestrator/session.ts:184-186` :

```ts
private _lastActivityAt: string;
private _idleSince: number; // epoch ms — used by mailbox idle detection (Phase 3)
```

Cycle de vie :

- Init (`session.ts:219-221`) : `_lastActivityAt = startedAt`,
  `_idleSince = Date.now()`.
- **Sur chaque chunk PTY** (`session.ts:769-776`) :
  `agent.onData → _lastActivityAt = now; _idleSince = Date.now(); _notifyState(false)`.
- **`notifySignal`** (`session.ts:606-628`) **ne met PAS à jour**
  `lastActivityAt` (commentaire ligne 625) — les signaux serveur ne
  sont pas de l'activité agent. Bien.

### Exposition

- Getter public `Session.lastActivityAt` (`session.ts:553-555`),
  `Session.idleSince` (`session.ts:558-560`).
- `SessionView.lastActivityAt: string` (`session.ts:108`) → REST
  `GET /orchestrators/:id`.
- Mirror frontend `packages/web/src/api/client.ts:76`.
- Persisté DB `persistence.ts:163` / réhydraté ligne 210.

### Consommateurs serveur existants

`messaging.ts:91-106` définit déjà `isIdle(session, now, idleThresholdMs)` —
utilisé pour décider d'envoyer ou non un PTY-signal après un
`team.send_message`. Seuil `SWARM_OS_IDLE_THRESHOLD_MS` défaut
**2 000 ms** (`config.ts:225`). **Ce seuil est différent du seuil
"UX idle visuel"** — ne pas réutiliser.

### Consommateurs frontend du statut

- `StatusBadge.tsx` — connaît pas `idle`, reçoit `status: string` brut.
- `OrchestratorView.tsx:106,200` — badges orch + session.
- `OrchestratorList.tsx:113` — badge orch uniquement.
- `useEvents.ts` — écoute `session.status_changed` pour les toasts
  `waiting`, aucune notion d'idle.
- Le futur `lib/sessionStatus.ts` prévu par **S3** est la cible
  naturelle pour la dérivation.

### `idle` n'est PAS dans l'enum serveur

`session.ts:22-29` et mirror `client.ts:68` : 7 valeurs, pas d'`idle`.

## 3. Décision recommandée : option 2 (frontend dérivé)

Justifications :

1. **Coût** : 0 changement serveur, 0 migration DB, 0 risque de
   casser le contrat REST/WS, Discord (`notify/index.ts:33`), `/metrics`.
2. **Sémantique correcte** : `idle` est une **vue UX** ("ce process
   murmure-t-il ?"), pas un état système. Le serveur ne change pas
   de comportement quand un PTY se tait.
3. **Réutilisation existante** : `lastActivityAt` déjà persisté, déjà
   mirroré, déjà rafraîchi à chaque chunk PTY.
4. **Pas de bug stale** : `OrchestratorView` re-poll toutes les 2 s
   (`OrchestratorView.tsx:45`), un `setInterval` local
   `useNow` (5 s) anime la transition sans dépendre d'un WS event.
5. **Cohérence avec S3** : on ajoute un wrapper `enrichWithIdle`
   en amont de `mapSessionStatusToVisual`. Le switch exhaustif S3
   ne change pas — il ne voit jamais `idle` (qui est purement visuel).

Option 1 (server-side) pertinente quand on aura besoin que **d'autres
consommateurs serveur** (Discord, /metrics, audit) voient l'`idle`. À
ce stade : YAGNI.

## 4. Fichiers à modifier

### Option 2 (recommandée — frontend)

| Fichier | Changement |
|---|---|
| `packages/web/src/lib/sessionStatus.ts` (créé par S3) | Ajouter `enrichWithIdle(view, now, threshold?)` + constante `IDLE_VISUAL_THRESHOLD_MS = 30_000` |
| `packages/web/src/hooks/useNow.ts` (**nouveau**) | Hook retournant `Date.now()` rafraîchi toutes les 5 s |
| `packages/web/src/components/StatusBadge.tsx` | Prop optionnelle `lastActivityAt?: string` ; appeler `useNow` + `enrichWithIdle` quand fournie |
| `packages/web/src/components/OrchestratorView.tsx` | Passer `lastActivityAt={session.lastActivityAt}` au badge session (ligne 200) |
| `packages/web/src/lib/sessionStatus.test.ts` | Tests `enrichWithIdle` (running stale → idle ; waiting stale → waiting ; etc.) |
| `packages/web/src/components/StatusBadge.test.tsx` | Test fake-timers de transition RUNNING → IDLE après 30 s |

Aucun fichier serveur modifié.

### Option 1 (server-side — réserve)

Si pivot futur :

| Fichier | Changement |
|---|---|
| `server/src/modules/orchestrator/session.ts:22-29` | Ajouter `'idle'` à `SessionStatus` |
| `session.ts` | Méthode `markIdleIfStale(now, threshold)` ; sortie d'idle dans `agent.onData` avant l'update de `_lastActivityAt` |
| `orchestrator/index.ts` | `setInterval(5_000)` ticker par orchestrator, `unref()`, stop sur destroy |
| `config.ts` | Ajouter `idleVisualThresholdMs` (env `SWARM_OS_IDLE_VISUAL_MS`, défaut `30_000`) |
| `persistence.ts` | Persister/réhydrater `idle` ; sur recovery, recalcul selon `last_activity_at` |
| `web/src/api/client.ts:68` | Étendre l'union |
| `web/src/lib/sessionStatus.ts` | `case 'idle'` dans le switch S3 |
| `notify/*` | Décider : `idle` notifie-t-il ? Probablement non — ignore explicite |
| Tests | `vi.useFakeTimers()` + `advanceTimersByTime(31_000)` |

## 5. Plan d'implémentation (option 2)

### 5.1 `useNow`

```ts
// packages/web/src/hooks/useNow.ts
export function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
```

### 5.2 `enrichWithIdle`

```ts
export const IDLE_VISUAL_THRESHOLD_MS = 30_000;

export function enrichWithIdle(
  view: Pick<SessionView, 'status' | 'lastActivityAt'>,
  now: number,
  thresholdMs = IDLE_VISUAL_THRESHOLD_MS,
): VisualDescriptor {
  const base = mapSessionStatusToVisual(view.status);
  if (view.status !== 'running') return base;
  const age = now - Date.parse(view.lastActivityAt);
  if (!Number.isFinite(age) || age < thresholdMs) return base;
  return {
    visual: 'idle',
    label: 'IDLE',
    pulse: false,
    tooltip: `No PTY output for ${Math.floor(age / 1000)} s`,
  };
}
```

### 5.3 `StatusBadge`

- Accepter prop `lastActivityAt?: string`.
- Appeler `useNow()` **toujours** (Rules of Hooks) ; le ternaire
  porte sur l'argument, pas l'appel.
- `lastActivityAt` présent → `enrichWithIdle`. Absent → fallback
  pur `mapSessionStatusToVisual`.

### 5.4 Câblage `OrchestratorView`

Ligne 200 : `<StatusBadge status={session.status} lastActivityAt={session.lastActivityAt} />`.
Ligne 106 (orch) : inchangé — pas de `lastActivityAt` au niveau orch.

### 5.5 Pas de changement WS

`useEvents.ts` continue d'écouter `session.status_changed`
pour les toasts `waiting`. Aucune confusion avec idle (qui n'émet
jamais d'event).

## 6. Seuils et UX

### 30 s — bon seuil ?

| Contexte | Cadence PTY | Implication |
|---|---|---|
| Claude en génération | rafale par token | rafraîchi en permanence |
| Entre deux tools | quelques secondes blanc | `running`, OK |
| Tool long (bash, build) | 5-60 s sans output | risque faux positif `idle` |
| Hook `Stop` posé | plus de PTY | déjà `waiting` (prioritaire sur idle) |
| Plan mode no-op | minutes sans output | `idle` justifié |

**Verdict** : 30 s est raisonnable. Plus court (10 s) → faux positifs
sur tests/compilation. Plus long (2 min) → l'agent paraît actif
quand il dort.

### Granularité visuelle

- Transition discrète : couleur vert → gris clair, **pas de pulsation**
  (réservée à `waiting`).
- Pas de notification, pas de toast — info ambiante.
- Tooltip avec âge exact ("no output for 47 s").

### Coût `useNow`

5 s × N sessions visibles = ~2 re-renders/s pour 10 sessions —
négligeable. Hoister `useNow` au niveau `OrchestratorView` est une
optim possible si N>>10, pas nécessaire en v1.

## 7. Tests à écrire

### `sessionStatus.test.ts`

- `enrichWithIdle({ status: 'running', lastActivityAt: now - 5s }, now)` → `running`.
- `enrichWithIdle({ status: 'running', lastActivityAt: now - 35s }, now)` → `idle`,
  `label: 'IDLE'`, `pulse: false`.
- `enrichWithIdle({ status: 'waiting', lastActivityAt: now - 60s }, now)` → `warn`
  (pas d'override sur waiting).
- `enrichWithIdle({ status: 'failed' | 'killed' | 'exited' | 'interrupted', … }, now)`
  → respectivement `bad / stopped / stopped / stopped` (jamais `idle`).
- `enrichWithIdle({ status: 'running', lastActivityAt: 'garbage' }, now)` →
  `running` (guard `Number.isFinite`).
- Custom threshold : `enrichWithIdle(view, now, 5_000)` bascule à 10 s.

### `StatusBadge.test.tsx` (fake timers)

```ts
it('transitions running → idle after 30 s', () => {
  vi.useFakeTimers();
  const stale = new Date(Date.now() - 5_000).toISOString();
  const { rerender, container } = render(
    <StatusBadge status="running" lastActivityAt={stale} />,
  );
  expect(container.textContent).toContain('RUNNING');
  vi.advanceTimersByTime(30_000);
  rerender(<StatusBadge status="running" lastActivityAt={stale} />);
  expect(container.textContent).toContain('IDLE');
  vi.useRealTimers();
});
```

### Test manuel

1. Orch avec `skipSpawn=true` (PTY ne produit rien après marker).
2. Badge session : `RUNNING` puis `IDLE` après ~30 s.
3. Vrai orch + commande `sleep 60` → `IDLE` pendant le sleep,
   `RUNNING` dès que le shell répond.
4. Vérifier qu'aucun WS event `status === 'idle'` n'est émis
   (DevTools Network → ws frames).

## 8. Gotchas

### Conflit avec `waiting`

Les deux sémantiques se chevauchent ("agent silencieux"). Règle :

- `waiting` (statut explicite posé par hook Stop) → **prioritaire**.
- `enrichWithIdle` n'override **que** `running`.

### Conflit avec `paused` (S5)

S5 ajoutera `paused` à l'enum. Comme `enrichWithIdle` ne touche que
`running`, `paused` passe à travers sans modification. Aucun
ordonnancement requis avec S5.

### `idle` n'existe PAS dans l'enum serveur

Conséquences acceptées :

- Aucun WS event `status: 'idle'`. Un consommateur qui filtre dessus
  ne déclenchera jamais.
- DB ne persiste pas `idle`. Une session visuellement `idle` au
  moment d'un crash réhydrate `running` puis re-dérive `idle`
  immédiatement (lastActivityAt ancien). **OK**.
- Notifier Discord et `/metrics` ne voient pas `idle` — un sleep de
  60 s ne mérite pas une notif.

### Ne pas casser les autres consommateurs

Comme l'enum reste inchangé, **rien à casser** :

- `OrchestratorList`, `useEvents`, `Terminal` lisent `status` brut,
  ne voient pas `idle`. Cohérent.
- Serveur (`messaging.ts`, `notify/`) continue avec le statut canonique.
- Tests existants : aucun changement de comportement serveur.

### `lastActivityAt` stale en cas de perte de polling

`OrchestratorView.tsx:45` poll toutes les 2 s ; échec silencieux
(`OrchestratorView.tsx:40`). Si réseau coupe, `lastActivityAt` se
fige → UI bascule en `IDLE` au bout de 30 s même si PTY actif.
**Acceptable** : un réseau cassé doit se voir visuellement.
`useEvents.connected` peut surcharger un indicateur global.

### Throttle `_notifyState(false)` côté serveur

`session.ts:776` met à jour `_lastActivityAt` à chaque chunk PTY ;
le callback persistence est throttlé (DB ~1×/s), **mais** l'API REST
`GET /orchestrators` lit `Session.toView()` en mémoire (live).
Donc côté HTTP, `lastActivityAt` est toujours à jour. Bon.

### Granularité `useNow`

Tick 5 s → au pire 5 s de retard sur la bascule. Sur seuil 30 s,
imperceptible. Compteur live ("idle for 12 s") demanderait 1 s —
hors scope v1.

## 9. Dépendances

| Ticket | Lien |
|---|---|
| **S1** (compteur) | Indirect — un PTY-signal post-message met à jour `_lastActivityAt` → sort de `idle`. Pas de coord. |
| **S2** (event mailbox) | Idem S1 — message peut réveiller l'agent → réveil. |
| **S3** (mapping visuel) | **Fort** — `enrichWithIdle` vit dans `lib/sessionStatus.ts`. S3 doit livrer en premier ou en même temps. |
| **S5** (paused) | **Faible** — enrichWithIdle ne touche que `running`. Aucun ordre requis. |
| **S7** (health agrégé) | **Moyen** — `health` doit agréger le **status canonique** (pas `idle` dérivé) ; un sleep silencieux ne dégrade pas la santé. |
| **U0.6** (lifecycle UI) | Compatible. Documenter `idle` comme vue dérivée. |

## 10. Critères d'acceptation

1. **Aucun fichier sous `packages/server/src/` n'est modifié** par S6
   (revue git).
2. **`lib/sessionStatus.ts` exporte** `enrichWithIdle(view, now, threshold?)`
   et `IDLE_VISUAL_THRESHOLD_MS = 30_000`.
3. `enrichWithIdle({ status: 'running', lastActivityAt: now - 35s }, now).visual === 'idle'`.
4. `enrichWithIdle({ status: 'waiting', lastActivityAt: now - 60s }, now).visual === 'warn'`
   (pas d'override).
5. `enrichWithIdle({ status: 'failed', … }, now).visual === 'bad'`.
6. `lastActivityAt: 'garbage'` ne crashe pas, reste `running`.
7. **`useNow`** rafraîchit `Date.now()` à intervalle régulier (test
   fake timers).
8. **`StatusBadge`** bascule à `IDLE` après 30 s quand `lastActivityAt`
   est passé en prop (test fake timers).
9. **`OrchestratorView.tsx:200`** transmet `lastActivityAt={session.lastActivityAt}`
   au badge session ; ligne 106 (orch) reste inchangée.
10. **`OrchestratorList` et badge orch (OrchestratorView:106)** restent
    inchangés (pas de notion d'idle au niveau orch).
11. **Pas de régression** : `pnpm -F @swarm-os/web test` passe ; build
    TS sans erreur.
12. **Test manuel** : orch en `skipSpawn=true` bascule visuellement à
    `IDLE` ~30 s après démarrage, **aucun** WS event ni notif Discord
    pendant la transition.
