# S5 — Actions per-session : stop / pause / resume / restart

> Analyse en profondeur du lot **S5** de `docs/internal/ui-redesign/update_system.md`.
> Aucun code de production ici — uniquement le plan.

---

## 1. Résumé du besoin

Le `RightPanel` du nouveau dashboard (cf. `prototypes/panels.jsx`,
groupe `pr-actions`) expose 4 boutons **per-session** : `STOP`,
`PAUSE`, `RESTART`, `KILL`. Aujourd'hui seul un équivalent
"arrêter la team" existe — via `DELETE /orchestrators/:id` qui appelle
`Spawner.destroy()` puis `Orchestrator.stop()` (SIGTERM / 5s / SIGKILL
sur **toutes** les sessions). Aucun endpoint REST ne cible **une**
session en particulier. S5 introduit 4 endpoints REST
`/sessions/:id/{stop,pause,resume,restart}`, étend `SessionStatus`
avec `paused`, et implémente les signaux Unix correspondants
(SIGTERM, SIGSTOP, SIGCONT) au-dessus de l'API node-pty déjà utilisée
par `PtyAgentProcess`.

## 2. État actuel

### 2.1 Enum `SessionStatus`

`packages/server/src/modules/orchestrator/session.ts:22-29`

```ts
export type SessionStatus =
  | 'starting' | 'running' | 'waiting'
  | 'exited' | 'killed' | 'interrupted' | 'failed';
```

7 valeurs, **aucune pour un état "agent suspendu / continuable"**.
Type dupliqué côté client (`packages/web/src/api/client.ts:68`), figé
en DB (colonne `sessions.status TEXT`, ouvert).

### 2.2 `Session.stop(reason, graceMs = 5000)` — déjà câblé

`session.ts:643-685`. Comportement :

1. Garde idempotente : early-return si statut ∈ `{exited, killed, failed, interrupted}`.
2. Set `_stopReason`, `_stopRequested = true`.
3. Pas d'`agent` (skipSpawn/disparu) → statut `killed` immédiat.
4. Sinon `agent.kill('SIGTERM')`, arme un timer SIGKILL après `graceMs`.
5. `_handleExit` final classifie en `killed` grâce à `_stopRequested`.

**C'est le seul path vers `killed`.** Émet `session.status_changed`
puis `session.exited`.

### 2.3 `Orchestrator.killWorker(id)` — kill ciblé worker

`orchestrator/index.ts:326-340`. Refuse les leads (`s.type !== 'worker'`),
délègue à `s.stop('killed-by-lead', 5000)`. Exposé via MCP
`team.kill_worker` (tools.ts:509-530), **pas en REST**.

### 2.4 `PtyAgentProcess` — signaux acceptés

`agent-process.ts:102-114` passe n'importe quelle string de signal POSIX
à `kill(2)` via node-pty. **SIGSTOP / SIGCONT directement utilisables**
sans nouvelle API native (vérifié dans `node-pty.d.ts:184` :
`kill(signal?: string): void`).

### 2.5 Routes REST sessions actuelles

`http/routes/sessions.ts` : `GET /sessions/:id`, `POST /sessions/:id/input`,
`GET /sessions/:id/log`. **Aucun endpoint d'action lifecycle.** Le seul
lifecycle REST est `DELETE /orchestrators/:id` (orchestrators.ts:264-268)
qui détruit la team complète.

### 2.6 Event bus

`events.ts` : 6 kinds dont `session.status_changed` (émis
automatiquement par `Session._setStatus`, session.ts:843-854) et
`session.exited`. **Toute transition vers `paused` / `running`
(resume) émettra l'event sans code supplémentaire** dès lors qu'on
appelle `_setStatus()`.

### 2.7 Verify-phase

`packages/server/scripts/verify-phase-{2,3,4}.ts` : boot serveur
in-process, drive via REST/WS, asserts inline, `process.exitCode = 1`
si un check échoue. C'est ce format que S5 ciblera.

## 3. Fichiers à modifier (chemins absolus)

| Fichier | Changement |
|---|---|
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/session.ts` | Étendre `SessionStatus` avec `'paused'`. Ajouter `pause()`, `resume()`. Patcher `stop()` pour gérer le cas paused (SIGCONT avant SIGTERM). |
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/index.ts` | Ajouter `stopSession()`, `pauseSession()`, `resumeSession()`, `restartSession()`. Étendre `_isActive()` (paused = actif). |
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/spawner/index.ts` | `shutdownAll()` doit SIGCONT avant SIGTERM. Éventuellement nouveau compteur `sessions_paused`. |
| `/home/ubuntu/projets/swarm-os/packages/server/src/http/routes/sessions.ts` | 4 routes POST `/sessions/:id/{stop,pause,resume,restart}`. Erreurs typées 404/409. |
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/db/index.ts` | Vérifier que `markAllNonTerminalAsInterrupted` balaie aussi les `paused`. |
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/messaging.ts` | `notifySignal()` skip si recipient paused (le push mailbox reste OK). |
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/agent-process.ts` | Étendre `FakeAgentProcess.kill(sig)` : SIGSTOP/SIGCONT n'exitent **pas** (mémoriser dans un tableau `signals`). |
| `/home/ubuntu/projets/swarm-os/packages/web/src/api/client.ts` | Aligner le type `SessionStatus`. |
| `/home/ubuntu/projets/swarm-os/packages/web/src/lib/sessionStatus.ts` (S3) | `case 'paused': return { visual: 'idle', label: 'PAUSED', pulse: false }`. |
| `/home/ubuntu/projets/swarm-os/packages/server/scripts/verify-phase-5.ts` (**nouveau**) | Suite verify-phase couvrant les 4 transitions. |
| `/home/ubuntu/projets/swarm-os/packages/server/src/modules/orchestrator/session.test.ts` | Tests unitaires pause/resume/restart/stop. |

## 4. Plan d'implémentation détaillé

### 4.1 Extension de l'enum

```ts
export type SessionStatus =
  | 'starting' | 'running' | 'paused' | 'waiting'
  | 'exited' | 'killed' | 'interrupted' | 'failed';
```

Conséquences en cascade :
- Le `switch` exhaustif de `mapSessionStatusToVisual` (S3)
  **cassera la compilation** — voulu (cf. `03_statut_waiting.md` §8).
- DB : pas de migration (`status TEXT`). Vérifier que
  `markAllNonTerminalAsInterrupted` utilise une logique `NOT IN
  ('exited','killed','interrupted','failed')` (robuste à l'ajout).
- `Orchestrator._isActive()` (index.ts:426-428) doit retourner `true`
  pour `paused`.
- `Spawner.counters()` : exclure `paused` de `sessions_active` ;
  exposer `sessions_paused` séparément dans `/health` (recommandé v1).

### 4.2 `POST /sessions/:id/stop` (workers seulement)

```
→ 200 { stopped: true,  status: 'killed' }
→ 404 si inconnue
→ 409 LEAD_NOT_STOPPABLE       (utiliser DELETE /orchestrators/:id)
→ 409 ALREADY_TERMINATED
```

**Note** : S5 propose "alias vers `destroyOrchestrator`" sur lead. Je
**déconseille** : `POST /sessions/:lead/stop` qui tue toute la team est
un foot-gun. 409 explicite + message clair pointant vers
`DELETE /orchestrators/:id`.

Implémentation : `spawner.findSession(id)` → 404. Si `type === 'lead'`
→ 409. Si statut terminal → 409. Sinon `session.stop('user-stop-rest',
5000)` + 200 immédiat. Le `killed` arrive après grace via `onExit`.

### 4.3 `POST /sessions/:id/pause`

**Sémantique** : SIGSTOP au PTY, statut `paused`. Le process n'est pas
tué — il reste comptable mais inerte.

```ts
pause(reason: string): boolean {
  if (this._status === 'paused') return false;                  // idempotent
  if (this._status !== 'running' && this._status !== 'waiting') return false;
  if (!this.agent) return false;                                // skipSpawn
  if (this._stopRequested) return false;                        // race §7.3
  this._statusBeforePause = this._status;                       // pour resume
  try { this.agent.kill('SIGSTOP'); } catch { return false; }
  this._setStatus('paused');
  this._appendLog(`[swarm-os] PAUSE (SIGSTOP) — ${reason}\n`);
  return true;
}
```

**Garde-fous** :
- `starting` interdit : agent en cours de boot, geler maintenant le
  bloquerait avant identification.
- `_stopRequested` true → refuser (un stop est en cours).
- **Ne PAS** mettre `_stopRequested = true` (sinon `_handleExit`
  classifierait un exit ultérieur en `killed` même après un resume +
  exit naturel 0).

**Event** : `session.status_changed` (`{ status: 'paused' }`). PAS de
`session.exited`.

### 4.4 `POST /sessions/:id/resume`

SIGCONT au PTY. `paused → _statusBeforePause` (waiting si c'était le
cas, sinon running).

```ts
resume(reason: string): boolean {
  if (this._status !== 'paused') return false;
  if (!this.agent) return false;
  try { this.agent.kill('SIGCONT'); } catch { return false; }
  const restored = this._statusBeforePause ?? 'running';
  this._statusBeforePause = null;
  this._setStatus(restored);
  this._appendLog(`[swarm-os] RESUME (SIGCONT) — ${reason}\n`);
  return true;
}
```

Restaurer `waiting` si capturé évite un flicker `paused → running →
waiting` quand le hook Stop sera ré-émis.

```
→ 200 { resumed: true, status: 'running' | 'waiting' }
→ 409 NOT_PAUSED
→ 404
```

### 4.5 `POST /sessions/:id/restart` (workers seulement)

**Sémantique** : kill propre + re-spawn d'une **nouvelle session** avec
la même config. Lead interdit (cf. §5.2).

```
→ 201 { oldSession, newSession, note: "PTY history lost..." }
→ 404
→ 409 LEAD_NOT_RESTARTABLE
→ 409 RESTART_IN_PROGRESS         (race §7.3)
```

Steps dans `Orchestrator.restartSession(oldId)` :

1. `s = sessions.get(oldId)`; 404 si absent.
2. Refuser si `s.type === 'lead'`.
3. Refuser si `s._restarting === true`. Poser le flag.
4. Si vivant : `s.stop('restart-requested', 5000)`. Sinon : passer.
5. Recapturer la config via les accesseurs (§5.3).
6. `addWorker({ name, role, prompt, cwd, model, effort,
   permissionMode, preamble })`. Le préambule est reconstruit via
   `buildPreamble()` parce que le `sessionId` change.
7. Émettre `session.exited` (ancien, via `_handleExit`) +
   `session.created` (nouveau). Pas de nouveau kind (cf. §4.6).

### 4.6 Événements WS — pas d'extension nécessaire

`SwarmEventKind` n'a **pas besoin d'être étendu** :
- pause/resume → `session.status_changed`
- stop → `session.status_changed` + `session.exited`
- restart → triple event : `status_changed(killed)` +
  `exited` (ancien) + `created` (nouveau).

Le frontend corrèle `(oldId, newId)` via la réponse REST 201. Un
hypothétique `session.restarted { oldId, newId }` reste nice-to-have.

## 5. Sémantique du restart

### 5.1 Décision : nouvelle session, nouvel UUID

Justifications (preuves dans le code) :

1. **DB append-mostly** : `sessions` row de l'ancienne reste visible
   dans `GET /orchestrators/:id` avec ses `started_at`, `ended_at`,
   `last_error`, `log_path`. Réutiliser l'id imposerait écraser ou
   indexer `(id, attempt)`.
2. **Log file** `<logsDir>/<orch>/<sid>.log` (session.ts:227). Réutiliser
   l'id = soit truncate (perte du contexte) soit append (terminal hub
   verra deux runs entremêlés).
3. **WS `/ws/sessions/:id`** : le terminal hub ouvert sur l'ancien sid
   doit voir le process se fermer + reconnecter explicitement au
   nouveau. Sémantique close/re-open plus claire.
4. **MCP `--mcp-config`** : `mcp.json` minté avec un `sessionSecret`
   lié au `session.id` (mcp-config.ts via `Session._spawn` ligne
   695-714). Réutiliser l'id avec nouveau secret casserait les
   requêtes pendantes.
5. **`addWorker` mint déjà un UUID v4** — pas de nouveau code.

### 5.2 Lead non-restartable

Restart de lead = recréer toute la team (les workers ont mailbox liée
au lead.id qui change, MCP `--mcp-config` invalide, etc.). Équivalent
à `DELETE` + `POST /orchestrators`. Hors scope S5. Renvoyer 409
`LEAD_NOT_RESTARTABLE`.

### 5.3 Conservation de la config

| Champ | Source | Notes |
|---|---|---|
| `name`, `role`, `cwd` | `s.name`, `s.role`, `s.cwd` | identiques |
| `model`, `effort` | `s.model`, `s.effort` | identiques |
| `permissionMode` | `s.permissionMode` | **doit rester `bypassPermissions` si applicable** (réinjecté par `addWorker` → `buildClaudeArgs`) |
| `preamble` | `buildPreamble({ identity: { ...sessionId: newId } })` | recalculé : le `sessionId` change → identité dans le préambule change |
| `prompt` | `s.initialPromptRaw` (session.ts:203) | recommandation : `${initialPromptRaw}\n\n[Note: session restarted by operator. Previous conversation lost.]` |
| `orchestratorId`, `type` | identiques | type toujours `'worker'` (lead refusé) |

### 5.4 Marqueur de l'ancienne session

`Session.stop()` la classifie déjà en `killed` (via `_stopRequested`).
Distinguer via `stopReason: 'restart-requested'`. **Ne pas** réutiliser
`interrupted` qui est aujourd'hui réservé à "le serveur a redémarré au
milieu de la session" (`DbPersistence.recoverFromCrash`,
session.ts:644). Mélanger les usages diluerait le signal.

## 6. Tests à écrire

### 6.1 Unit `session.test.ts`

Prérequis : étendre `FakeAgentProcess` pour que `kill(SIGSTOP)` /
`kill(SIGCONT)` **n'exitent pas** mais mémorisent le signal reçu
(`signals: string[]`). Sans ça, `pause()` exiterait le fake process →
faux positifs.

| Test | Vérifie |
|---|---|
| `pause()` depuis running | statut `paused` ; `agent.signals` contient `SIGSTOP` ; event émis |
| `pause()` depuis waiting | `_statusBeforePause === 'waiting'` |
| `pause()` en double idempotent | retour `false`, pas de re-émission |
| `pause()` refuse `starting/exited/killed/failed/interrupted` | retour false, statut inchangé |
| `pause()` refuse si `_stopRequested` | retour false |
| `resume()` depuis paused → running | SIGCONT, statut running |
| `resume()` restaure waiting si capturé | statut `waiting` |
| `resume()` depuis non-paused | retour false |
| `stop()` depuis paused | SIGCONT injecté **avant** SIGTERM ; statut final `killed` (cf. §7.5) |
| `restart()` recapture model/effort/permissionMode/cwd | tests paramétrés sur les 4 champs |
| `restart()` newSession.id !== oldSession.id | identités distinctes |
| `restart()` ancienne en statut `killed` + `stopReason='restart-requested'` | DB row contient le marqueur |

### 6.2 Unit `orchestrator/index.test.ts`

| Test | Vérifie |
|---|---|
| `stopSession()` refuse lead | `LEAD_NOT_STOPPABLE` |
| `restartSession()` refuse lead | `LEAD_NOT_RESTARTABLE` |
| `pauseSession() + resumeSession()` n'altère pas la mailbox | `mailbox.size(sid)` inchangé |
| `_isActive(paused) === true` | la session paused compte pour le cap workers |
| `_onWorkerExit` pas appelé pendant pause | pas de message synthétique au lead |
| Double `restartSession()` concurrent → un seul gagne | flag `_restarting` |

### 6.3 E2E REST (verify-phase-5.ts)

Pattern calqué sur `verify-phase-4.ts`. Boot serveur in-process, WS
`/ws/events`, créer orch + 1 worker.

Couverture minimale (skipSpawn OK pour 1-5) :

1. `POST /sessions/<unknown>/stop` → 404
2. `POST /sessions/<lead>/stop` → 409 `LEAD_NOT_STOPPABLE`
3. `POST /sessions/<lead>/restart` → 409 `LEAD_NOT_RESTARTABLE`
4. `POST /sessions/<worker>/stop` → 200, polling jusqu'à `status === 'killed'`
5. Re-`POST /sessions/<worker>/stop` après terminé → 409 `ALREADY_TERMINATED`

Couverture étendue (skip si `claude` indisponible — `SIGSTOP`
nécessite un vrai PTY) :

6. `POST /sessions/<worker>/pause` → 200, statut `paused`, event WS
7. `POST /sessions/<paused>/resume` → 200, statut `running`, event WS
8. `POST /sessions/<worker>/restart` → 201, `oldSession.id !==
   newSession.id` ; events `session.exited` (ancien) +
   `session.created` (nouveau) reçus

## 7. Gotchas

### 7.1 SIGSTOP / SIGCONT sur Linux container

Container non-privilégié : le swarm-os server (PID 1 du container) →
ses enfants `claude` (même cgroup, parent direct) marche sans
capability spéciale. node-pty fait juste `kill(pid, SIGSTOP)`. **Edge** :
sous-process forkés par claude (serveur MCP local, etc.) ne sont pas
gelés ; pour swarm-os ce n'est pas un problème, claude n'expose pas
d'IPC vers ses fils.

### 7.2 PID orphelin

Si swarm-os crash entre SIGSTOP et un éventuel SIGCONT, le PTY claude
reste figé. `recoverFromCrash` marque DB → `interrupted` mais le
**process Unix continue d'exister** (figé).

**Option A (recommandée)** : `Spawner.shutdownAll()` doit, pour
chaque session paused, faire SIGCONT puis SIGTERM (sinon SIGTERM est
mis en pending — délivré mais non traité tant que SIGSTOP). SIGKILL
final marche toujours, même sur un stopped.

**Option B** : au boot, scanner les `pid` persistés en DB et SIGKILLer
les vivants. Plus lourd, demande de persister `pid` au moment du
pause. Pas recommandé v1.

### 7.3 Races

- **Pause pendant un kill timer armé** : `Session.stop()` arme un
  timer SIGKILL après 5s. Si on `pause()` entre temps, on bloque
  SIGTERM (process stopped) mais le timer SIGKILL viendra quand même.
  Solution : `pause()` refuse si `_stopRequested === true`. Test à
  écrire.
- **Double restart concurrent** : deux POST simultanés → deux nouvelles
  sessions. Solution : flag `_restarting: boolean` sur la session,
  posé par `restartSession()`. Si déjà true → 409 `RESTART_IN_PROGRESS`.
- **Resume après exit naturel** : OOM kill, kill -9 externe peuvent
  exiter un paused. `_handleExit` transitionne `paused → killed/exited`.
  `resume()` doit re-check `agent && !exited` après SIGCONT ; sinon
  retour false + log.

### 7.4 Lead pause autorisé ?

**Pour** : opérateur veut geler le lead pour examiner état/logs/mailbox
sans perdre le contexte Claude.
**Contre** : workers continuent d'écrire dans sa mailbox pendant la
pause → débordement (cap `maxInboxSize`, oldest dropped). Lead
`bypassPermissions` au milieu d'une commande shell se retrouve gelé à
mi-chemin — resume sans réflexion reprend l'action.

**Recommandation v1** : **autoriser** (cohérence des 4 boutons). Doc
le débordement mailbox dans la réponse REST (`{ note: 'mailbox can
grow up to maxInboxSize during pause' }`).

### 7.5 Stop d'une session paused

SIGTERM sur process stopped = mis en pending (non traité tant que
SIGSTOP). Sans SIGCONT : `stop()` sur paused = process figé, timer
SIGKILL après 5s, statut `killed`. **Fonctionne mais 5s garanties.**

**Patch dans `Session.stop()`** : si `_status === 'paused'`, faire
`agent.kill('SIGCONT')` **avant** `agent.kill('SIGTERM')`. ~3 lignes.

### 7.6 `bypassPermissions`

Passé via `--permission-mode` à `claude` au spawn. Au restart : la
nouvelle session reçoit `permissionMode = oldSession.permissionMode`
via la recapture (§5.3). C'est `addWorker → buildClaudeArgs`
(session.ts:128-161) qui transmet. Pas de magie. Test
"restart propage bypassPermissions" couvre. Le `_seedClaudeJsonTrust`
qui pré-accepte le disclaimer est ré-écrit sur la nouvelle session
(constructeur → `_maybeWriteSessionSettings`). Bénin.

### 7.7 Perte de l'historique conversationnel

À documenter dans la réponse REST `/restart` (champ `note`) ET dans le
prompt re-injecté (§5.3 marker `[Note: session restarted by
operator]`). Le préambule prévient claude lui-même.

### 7.8 Mailbox pendant pause

`Mailbox.push(to, msg)` (mailbox.ts:74) + `notifySignal()` côté Session
si idle (via `messaging.ts:isIdle`).

**Décision** : `isIdle` retourne `false` pour un paused (donc pas de
signal), MAIS le push mailbox reste OK. Sinon le PTY write bufferisé
arrive en bloc à reprise et garble la prochaine action. Cohérent
avec la sémantique "paused = je lirai plus tard".

### 7.9 Interaction S3 (mapping visuel)

`paused → idle` (VisualStatus). Label `PAUSED`, pulse false, tooltip
`Suspendue (SIGSTOP)`. La couleur est partagée avec `starting`/`idle`
(distinction via label). À voir si on dédie une couleur en v2.

### 7.10 Interaction S6 (idle detection)

Si S6 implémente un tick périodique côté serveur, il doit
**explicitement ignorer** les `paused` (sinon flip vers `idle` 30s
plus tard écrase notre `paused`). Si S6 choisit l'alternative
low-effort (frontend), même exclusion côté front.

### 7.11 Interaction S7 (health agrégé)

Choix : `paused` dégrade-t-il la santé ?
- `ok` : l'opérateur a fait ce choix, pas une anomalie.
- `warn` : signal "il y a un agent gelé, n'oublie pas de le relancer".

**Recommandation** : `warn`. Plus prudent, plus cohérent avec le
RightPanel qui doit faire ressortir l'action requise. À synchroniser
quand S7 est rédigé.

## 8. Dépendances inter-tickets

| Ticket | Lien |
|---|---|
| **S3** (mapping visuel) | Casse le `switch` exhaustif → impose la mise à jour `case 'paused'`. À livrer dans le même PR ou immédiatement après. |
| **S6** (idle) | Le tick idle (si serveur) ou le calcul front doivent exclure `paused`. |
| **S7** (health) | Choix `paused → warn` (recommandé) à synchroniser. |
| **S1** (msgCount) | Aucun impact direct — la mailbox compte les messages livrés à un worker paused (push effectif). |
| **S2** (`mailbox.message` event) | Émis quand on push vers paused → frontend doit pulser même vers paused (sémantique : reçu, sera lu à reprise). |
| **U0.6** (UI lifecycle) | Doc UI à jour : nouveau statut `paused`. |
| **U1.x** (boutons RightPanel) | Câblage des 4 boutons → 4 endpoints. Dépend strictement de S5. |
| **MCP `team.kill_worker`** | Existe déjà (tools.ts:509-530). Cohabite avec REST. Documenter : REST = côté humain via UI, MCP = côté lead via tool. |

## 9. Critères d'acceptation vérifiables

1. **`SessionStatus`** inclut `'paused'`, propagé côté client.
2. **`Session.pause()` / `Session.resume()`** :
   - idempotentes (double call = no-op + retour false) ;
   - refusent les transitions invalides ;
   - émettent `session.status_changed` avec le nouveau statut ;
   - n'émettent **pas** `session.exited`.
3. **`Orchestrator.restartSession(id)`** :
   - refuse les leads (409 `LEAD_NOT_RESTARTABLE`) ;
   - retourne `{ oldSession, newSession }` avec
     `oldSession.id !== newSession.id` ;
   - newSession a `model/effort/permissionMode/cwd` identiques (test
     paramétré sur les 4 champs) ;
   - ancienne en `killed` + `stopReason: 'restart-requested'`.
4. **4 routes REST** sous `/sessions/:id/{stop,pause,resume,restart}` :
   - 404 pour id inconnu ;
   - stop/restart sur lead → 409 avec code typé ;
   - transitions illégales → 409 avec code typé ;
   - happy paths 200 (ou 201 pour restart).
5. **`agent.kill('SIGCONT')`** appelé sur une session paused avant
   tout `stop()` (vérifié unitairement).
6. **`Spawner.shutdownAll()`** SIGCONT avant SIGTERM sur paused (§7.2).
7. **`messaging.sendMessage`** n'injecte pas de `notifySignal` vers un
   recipient paused (test unitaire).
8. **DB `markAllNonTerminalAsInterrupted`** balaie aussi les `paused`
   (test : créer paused en DB, restart serveur, vérifier → `interrupted`).
9. **`verify-phase-5`** existe et passe en CI (checks 1-5 toujours,
   6-8 skip si `claude` indisponible).
10. **Doc S3** mise à jour : statut `paused` effectivement implémenté.
11. **Pas de régression** : `pnpm -F server test`, `pnpm -F web build`
    passent ; MCP `team.kill_worker` / `team.kill_all_workers`
    continuent de fonctionner.
12. **Pause d'un lead n'empêche pas la team de paraître active**
    (`Spawner.listActive()` retourne l'orch ; `_isActive(paused) === true`).
