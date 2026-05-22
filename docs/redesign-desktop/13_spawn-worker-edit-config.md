# Étape 13 (Phase C.13) — `SpawnWorkerDialog` et `EditConfigDialog` en mode preview disabled

> **Périmètre exact** : porter dans `packages/web/src/components/desktop/`
> deux modales du prototype v2 (`prototypes/v2/modals.jsx:312-372` pour
> `SpawnWorkerDialog`, `:374-426` pour `EditConfigDialog`) **en mode
> preview disabled v1** : visuel et formulaires complets, mais le bouton
> de soumission est désactivé, avec un tooltip clair qui pointe sur le
> gap serveur correspondant et propose un workaround documenté. Les
> deux modales sont câblées dans le `DesktopShell` (states déjà
> existants `spawnFor` / `editConfigFor` depuis Step 2) et déclenchées
> depuis le `RightPanel` (bouton `+ WORKER` et bouton edit pencil sur la
> cfgline — câblage Step 7).
>
> Pré-requis :
> - **Étape 1** (`desktop-theme.css`) — classes `.modal-backdrop`,
>   `.modal`, `.modal-head/body/foot`, `.field`, `.field-row`,
>   `.field-help`, `.field-warn`, `.seg-radio`, `.btn.primary/ghost`,
>   `.pr-close`, variables `--warn`, `--bad`, `--amber`, `--text-mute`.
> - **Étape 2** (squelette `desktop/`) — stubs
>   `SpawnWorkerDialog.tsx` et `EditConfigDialog.tsx` créés avec
>   `export default function … () { return null; }` ; states
>   `spawnFor` / `editConfigFor` déjà déclarés dans `DesktopShell`
>   (préfixés `_` ou destructurés sans getter en Step 2, à dépréfixer
>   dans cette étape).
> - **Étape 7** (`RightPanel` data binding) — props `onSpawnWorker(team)`
>   et `onEditConfig(team)` câblées sur le bouton `+ WORKER`
>   (`disabled={!isLead || stopped || isFailed}`) et sur le bouton
>   pencil de la `pr-cfgline`.
> - **Étape 9** (`NewOrchestratorDialog`) — convention `.seg-radio` pour
>   EFFORT, et constantes `MODELS` / `EFFORTS` / `PERMS` portées dans
>   `desktop/constants.ts` (ou inlinées si encore non-extraites, à
>   centraliser à cette étape — voir §11).
>
> Backend : **aucun changement**. Les deux modales s'appuient sur les
> gaps **§4-2** (`PATCH /orchestrators/:id` absent) et **§4-3**
> (`POST /orchestrators/:id/workers` absent) du plan parent. Aucun MCP
> tool n'est appelé depuis le frontend (les MCP tools sont strictement
> intra-agent — cf. §3).

---

## 1. Objectif

Donner à l'opérateur **le visuel complet** des deux opérations
"`+ WORKER`" et "rotate model/effort/permission" — pour qu'il sache
qu'elles existeront, qu'il puisse en évaluer la forme et les champs
attendus, et qu'il ne soit pas surpris par leur absence — **sans
prétendre les exécuter v1**. Les boutons de soumission sont disabled,
un tooltip explicite renvoie au gap, et un encart `field-warn`
documente le workaround possible (broadcast au lead pour
`SpawnWorker`, destroy+recreate pour `EditConfig`). Le but est triple :

1. **Pas de régression UX** vs prototype v2 — les modales s'ouvrent,
   les champs sont saisissables, la validation client est active.
2. **Pas d'illusion d'action** — l'opérateur ne doit jamais penser
   qu'un clic vide a effectivement spawn un worker ou rotaté un
   modèle.
3. **Documentation in-app du gap** — l'opérateur lit la raison du
   disabled, la roadmap implicite ("v2") et l'alternative qui existe
   *si* il accepte le coût (perte de contexte session pour edit ;
   nécessite un lead actif pour spawn).

---

## 2. Sources v2 — rappel exact

### 2.1 `SpawnWorkerDialog` (`prototypes/v2/modals.jsx:312-372`)

Champs : `name` (forcé UPPERCASE à la frappe), `roleId` (dropdown sur
tous les roles **sauf** `'ORCHESTRATOR'`), `override` (textarea worker
preamble override, optionnel — placeholder = preamble par défaut du
role).

Footer : `CANCEL` (`.btn.ghost`) + `SPAWN →` (`.btn.primary`,
`disabled` si `name.trim().length === 0`, `opacity: 0.4` quand
disabled).

`.field-help` en bas du body : `New worker will inherit MODEL {model}
· EFFORT {effort} · PERM {perm} from {team.name}.` — sert à rassurer
l'opérateur sur les valeurs héritées (l'opérateur ne les choisit pas,
contrairement à `NewOrchestratorDialog`).

`onSpawn` reçoit `{ name, roleLabel, shape, workerPreamble }` —
spécifique au mock du proto. Dans le port TS on **n'invoque jamais**
`onSpawn` v1 (le bouton est disabled). La signature de la prop reste
définie pour quand l'endpoint arrivera.

### 2.2 `EditConfigDialog` (`prototypes/v2/modals.jsx:374-426`)

Champs : `model` (dropdown sur `window.MODELS`), `effort`
(`.seg-radio` sur `window.EFFORTS`), `perm` (dropdown sur
`window.PERM_MODES`). Pré-remplis depuis `team.{model,effort,permissionMode}`.

`field-help` ambré en tête de body : `⚠ Saving will restart all
sessions in this team with the new triplet.`

Footer : `CANCEL` + `ROTATE + RESTART →`. Le proto **n'a pas** de
`disabled` initial (toujours actif). Le `bypassPermissions` déclenche
un `field-warn` supplémentaire sous le dropdown PERMISSION.

`onSave` reçoit `{ model, effort, permissionMode }`. Dans le port TS,
**non invoqué** v1.

---

## 3. Décision UX : disabled-with-tooltip vs hide vs workaround

Pour chaque modale on dispose de trois grandes options. Le tableau
ci-dessous tranche.

| Option | `SpawnWorkerDialog` | `EditConfigDialog` |
|---|---|---|
| **A. Modale absente** (le bouton ouvrant ne fait rien) | ❌ — l'opérateur ne sait pas que la feature existe, le bouton est trompeur | ❌ — idem, le pencil est trompeur |
| **B. Modale visible, bouton submit disabled + tooltip** | ✅ **retenu** | ✅ **retenu** |
| **C. Modale visible, bouton submit actif → workaround côté client** | ⚠ tentant (MCP relay via PTY) mais fragile (cf. §3.1) | ❌ destructeur (perte session) — refusé v1 |

L'option B est l'expression UI du principe énoncé dans le plan parent
(§4 dernière phrase, §5.4 point 3) : *"Stratégie : boutons grisés avec
tooltip `available in v2`"*. C'est cohérent avec les autres gaps
(REACTIVATE §4-8, composer INBOX en AGENT §4-5).

L'option C est **documentée dans la modale** comme un workaround
manuel possible, mais **pas exécutée par le bouton**. C'est important :
le workaround est un changement de niveau (l'opérateur passe par un
broadcast PTY ou par un destroy+recreate), pas une rotation atomique.
Le bouton submit, lui, doit refléter "la chose que je viens de saisir
ne sera pas exactement faite". Disabled + texte de workaround
explicite.

### 3.1 Pourquoi pas de workaround MCP automatique pour `SpawnWorker`

Le serveur expose `team.spawn_worker` en **MCP intra-agent**
(`packages/server/src/modules/mcp/tools.ts:384-506`). Ce tool n'est
**pas** invocable depuis le frontend — il n'y a pas de route REST qui
le proxy, et la session MCP est attachée à l'agent (pas à l'opérateur
via `X-Auth-Token`). Le seul chemin pour le déclencher depuis l'UI
serait :

1. Écrire un broadcast à l'orchestrator avec un texte structuré du
   genre `/spawn-worker name=PROBE-04 role=BUILDER prompt=…` (cf.
   `api.broadcastToOrchestrator(id, content)`).
2. Espérer que **le lead** (agent humanoïde Claude) parse ce broadcast,
   décide d'invoquer `team.spawn_worker` via son MCP client local, et
   ne se trompe pas dans les paramètres.

**Pourquoi c'est rejeté pour le bouton automatique** :

- **Pas de contrat** : on demande à un LLM d'agir comme un parser de
  commandes textuelles. Le lead peut refuser (raisonnement de
  sécurité), reformuler le worker (nom changé, role différent),
  oublier des champs, ou simplement ne pas répondre tout de suite (il
  est occupé).
- **Pas d'accusé de réception** : l'opérateur n'a aucun moyen de
  savoir si le worker a été spawned. Au mieux, il voit apparaître une
  nouvelle session dans MapView 5-30 s plus tard. Au pire, rien.
- **Pas de gestion d'erreur** : si le `team.spawn_worker` échoue
  côté serveur (WorkerCapError, INVALID_CWD), l'erreur revient dans
  la console PTY du lead, pas dans la modale qui s'est déjà fermée.
- **Effets de bord** : le broadcast `from='human'` arrive aussi dans
  les mailboxes de **tous les workers** existants — qui vont penser
  que l'opérateur leur a demandé quelque chose à eux aussi.

Le workaround MCP-via-PTY-broadcast **existe** et **doit être
documenté** dans la modale (l'opérateur veut savoir qu'il a une porte
de sortie), mais il **ne doit pas** être l'action par défaut du bouton
SPAWN. La forme retenue : un texte d'aide en bas du body,
copy-pastable, du genre :

```
Workaround (manual): broadcast to the lead session →
  "Please call team.spawn_worker(name='PROBE-04', role='BUILDER',
   prompt='…') from your MCP client."
```

L'opérateur ferme la modale, ouvre le composer du RightPanel en mode
TEAM, et envoie le message. C'est explicite et traçable.

### 3.2 Pourquoi pas de workaround destroy+recreate automatique pour `EditConfig`

`destroyOrchestrator` (`DELETE /orchestrators/:id`) puis
`createOrchestrator` (`POST /orchestrators`) avec le nouveau triplet
**fonctionnerait techniquement**. Mais c'est **destructeur sans
contrepartie** :

- Le contexte de la session lead (historique LLM, fichiers édités,
  caches MCP) est perdu.
- Les workers actifs sont tous tués.
- Les inboxes (mailboxes) sont vidées — les messages non-lus sont
  perdus.
- Le nouveau orchestrator a un **id différent** ; les liens externes
  (URL `#/orchestrators/:id`, Discord webhooks signalés sur le vieux
  id) sont cassés.
- Le `stopReason` du vieux apparaît dans RECENTLY ENDED comme
  `killed` — bruit dans l'historique.

**Verdict** : trop coûteux pour être l'action implicite d'un bouton
labellisé "ROTATE + RESTART". L'opérateur qui veut quand même le faire
peut, en deux clics manuels :

1. Bouton STOP/KILL sur le lead → confirme dans `ConfirmModal`.
2. Bouton `+ NEW TEAM` dans la TopBar → renseigne le nouveau triplet.

C'est ce que la modale `EditConfigDialog` documente dans son
`field-help` workaround, avec un avertissement clair sur ce qu'on
perd. Le bouton submit reste disabled.

### 3.3 Synthèse

| Modale | Bouton submit | Tooltip bouton | Helper documentant le workaround |
|---|---|---|---|
| `SpawnWorkerDialog` | `disabled` | `available in v2 — see workaround below` | "Manually broadcast a `team.spawn_worker(...)` MCP instruction to the lead via the TEAM composer." |
| `EditConfigDialog` | `disabled` | `available in v2 — see workaround below` | "Manual workaround: STOP this team, then `+ NEW TEAM` with the new triplet. Loses session context, inboxes, and changes the team id." |

---

## 4. `SpawnWorkerDialog` — UI

### 4.1 Layout

```
┌─ modal (width: auto, max-width: 480px) ─────────────────────┐
│ + SPAWN WORKER  // in NOMAD                              ×  │
├─────────────────────────────────────────────────────────────┤
│ ┌─ field-row (2 cols) ────────────────────────────────────┐ │
│ │ NAME                  │ ROLE                            │ │
│ │ [PROBE-04         ]   │ [BUILDER         ▾]             │ │
│ └─────────────────────────────────────────────────────────┘ │
│ WORKER PREAMBLE OVERRIDE  // optional                       │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Leave empty to use the role's default worker preamble.  │ │
│ │ …                                                       │ │
│ └─────────────────────────────────────────────────────────┘ │
│ New worker will inherit MODEL opus-4-7 · EFFORT high ·      │
│ PERM bypassPermissions from NOMAD.                          │
│                                                             │
│ ┌─ field-warn (gap §4-3) ─────────────────────────────────┐ │
│ │ ⚠ available in v2 — POST /orchestrators/:id/workers     │ │
│ │   is not implemented yet.                               │ │
│ │   Manual workaround: open the TEAM composer on the lead │ │
│ │   and broadcast →                                       │ │
│ │   "Please call team.spawn_worker(name='PROBE-04',       │ │
│ │     role='BUILDER', prompt='…')."                       │ │
│ └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                                  CANCEL    [SPAWN →]disabled│
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Champs et défauts

| Champ | Type | Required (validation client) | Default | Notes |
|---|---|---|---|---|
| `name` | `string` (auto-`toUpperCase()` à la frappe) | oui (`trim().length > 0`) | `''` | autofocus, placeholder `e.g. PROBE-04`. La validation est faite *côté UI* pour préserver l'UX (le bouton signale `name manquant` même si in fine il restera disabled à cause du gap §4-3 — l'opérateur garde le feedback). |
| `roleId` | dropdown sur `roles.filter(r => r.label !== 'ORCHESTRATOR')` | oui (toujours présélectionné via `roles.find(...)?.id`) | premier role non-ORCHESTRATOR | Le proto filtre par `label !== "ORCHESTRATOR"` (on garde ce critère ; voir §11 pour la variante "filter by role.workerCount > 0"). |
| `override` | textarea optionnelle | non | `''` | placeholder = `role.workerPreamble` (string-substitué). Si vide, le worker héritera du preamble par défaut du role à l'envoi. |

### 4.3 JSX final

```tsx
// packages/web/src/components/desktop/SpawnWorkerDialog.tsx
import { useEffect, useMemo, useState } from 'react';
import type { OrchestratorView, RoleView } from '../../api/client';

interface Props {
  open: boolean;
  team: OrchestratorView | null;  // null when closed
  roles: readonly RoleView[];
  onClose: () => void;
  /**
   * Reserved for v2 once `POST /orchestrators/:id/workers` lands.
   * v1: never invoked (button is disabled).
   */
  onSpawn?: (spec: {
    name: string;
    roleId: string;
    roleLabel: string;
    workerPreambleOverride: string | null;
  }) => Promise<void>;
}

const GAP_TOOLTIP = 'available in v2 — see workaround below (gap §4-3)';

export default function SpawnWorkerDialog({ open, team, roles, onClose }: Props) {
  // Pré-sélectionne le premier role non-ORCHESTRATOR
  const workerRoles = useMemo(
    () => roles.filter((r) => r.label !== 'ORCHESTRATOR'),
    [roles],
  );
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState<string>('');
  const [override, setOverride] = useState('');

  // Reset chaque (ré)ouverture
  useEffect(() => {
    if (open) {
      setName('');
      setOverride('');
      setRoleId(workerRoles[0]?.id ?? '');
    }
  }, [open, workerRoles]);

  // Esc → onClose
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !team) return null;

  const role = workerRoles.find((r) => r.id === roleId) ?? workerRoles[0] ?? null;
  const nameValid = name.trim().length > 0;
  // v1 : toujours disabled (gap §4-3). nameValid est calculé pour le hint
  // visuel uniquement (opacity 0.4 même quand name valide, libellé identique).
  const canSpawn = false;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="spawn-worker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title" id="spawn-worker-title">
            + SPAWN WORKER{' '}
            <span className="sub">// in {team.name}</span>
          </div>
          <button className="pr-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label htmlFor="spawn-name">NAME</label>
              <input
                id="spawn-name"
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase())}
                placeholder="e.g. PROBE-04"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="spawn-role">ROLE</label>
              <select
                id="spawn-role"
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
              >
                {workerRoles.length === 0 && (
                  <option value="">— no worker roles available —</option>
                )}
                {workerRoles.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="spawn-override">
              WORKER PREAMBLE OVERRIDE{' '}
              <span style={{ color: 'var(--text-mute)' }}>// optional</span>
            </label>
            <textarea
              id="spawn-override"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              placeholder={
                role?.workerPreamble ??
                "Leave empty to use the role's default worker preamble."
              }
              style={{ minHeight: 80 }}
            />
          </div>

          <div className="field-help">
            New worker will inherit MODEL <b>{team.defaultModel.replace('claude-', '')}</b>{' '}
            · EFFORT <b>{team.defaultEffort}</b>{' '}
            · PERM <b>{team.defaultPermissionMode}</b>{' '}
            from {team.name}.
          </div>

          {/* gap §4-3 disclosure */}
          <div className="field-warn">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              ⚠ available in v2 — backend endpoint missing
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.55 }}>
              <code>POST /orchestrators/:id/workers</code> is not implemented
              yet (plan §4-3). The button below is disabled.
              <br />
              <span style={{ color: 'var(--text-mute)' }}>
                Manual workaround: cancel, open the TEAM composer on this
                lead, and broadcast:
              </span>
              <div
                style={{
                  marginTop: 6,
                  padding: '6px 8px',
                  background: 'rgba(232,176,74,0.06)',
                  borderLeft: '2px solid var(--amber)',
                  fontFamily: 'Geist Mono, monospace',
                  fontSize: 10.5,
                  color: 'var(--text)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {`Please call team.spawn_worker(\n  name="${nameValid ? name.trim() : 'PROBE-04'}",\n  role="${role?.label ?? 'BUILDER'}",\n  prompt="<your task here>"\n) from your MCP client.`}
              </div>
              <span style={{ color: 'var(--text-mute)' }}>
                The lead will receive it in its mailbox and may invoke the MCP
                tool. No acknowledgement is returned to the UI; the new
                session will appear in MapView once spawned.
              </span>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>CANCEL</button>
          <button
            className="btn primary"
            disabled={!canSpawn}
            style={{ opacity: 0.4, cursor: 'not-allowed' }}
            title={GAP_TOOLTIP}
            aria-disabled="true"
          >
            SPAWN → <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>(v2)</span>
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 4.4 Notes d'implémentation

- **`canSpawn` codé en dur à `false`** v1, sans dépendre de
  `nameValid`. Quand l'endpoint arrivera (gap §4-3 résolu), il
  suffira de remplacer par `nameValid && !!role && !submitting` et de
  retirer le bloc `.field-warn`. Le reste du composant reste tel quel.
- **`onSpawn` est optionnel et inutilisé en v1**, mais déclaré dans
  l'interface pour ne pas avoir à modifier le call-site
  (`DesktopShell`) le jour où on l'active.
- **Auto-`toUpperCase()` à la frappe** : convention v2 (cf.
  `prototypes/v2/modals.jsx:335`). Préserve la cohérence avec les
  team-pills (uniformément majuscules).
- **Le bloc `field-warn` montre dynamiquement le nom saisi** dans le
  template MCP : si l'opérateur a déjà tapé `PROBE-04`, le workaround
  apparaît `name="PROBE-04"` ; sinon, valeur par défaut `PROBE-04`.
  C'est un soin UX — le texte est *prêt à copier*.
- **Pas de submit handler `onSpawn` invoqué** : aucun risque d'effet
  de bord. Le bouton n'a même pas de `onClick`.
- **Filtre `roleId === ''` cas dégénéré** : si `roles` est vide ou ne
  contient que `ORCHESTRATOR`, la dropdown affiche `— no worker roles
  available —`. Le bouton reste disabled (de toute façon).

---

## 5. `SpawnWorkerDialog` — comportement (disabled vs workaround)

### 5.1 Choix retenu : disabled + workaround documenté in-modal

Le bouton `SPAWN →` est **toujours** disabled v1, indépendamment de la
validité du formulaire. Le `field-warn` documente le workaround MCP
manuel (broadcast au lead), avec un template de message prêt à coller
dans le composer TEAM.

### 5.2 Alternative envisagée (rejetée) : workaround MCP automatique

Voir §3.1. La synthèse :

| Critère | Workaround MCP auto (rejeté) | Disabled + texte de workaround manuel (retenu) |
|---|---|---|
| Fiabilité de l'exécution | LLM peut refuser/reformuler/oublier | Action explicite de l'opérateur |
| Accusé de réception | Aucun | L'opérateur sait qu'il a cliqué SEND |
| Gestion d'erreur | Erreur silencieuse dans la console PTY du lead | Erreur visible (composer affiche success/fail) |
| Effets de bord | Broadcast à tous les workers | Broadcast à toute l'équipe, mais explicite |
| Latence | 5-30 s (le temps que le lead réponde) | Idem mais l'opérateur sait quoi attendre |
| Cohérence avec le UX du reste de l'app | Création silencieuse, non-traçable | Reflète l'asynchronie réelle, traçable |
| Coût UI | Boucle, polling, état "submitting", undo impossible | Texte statique, copy-paste |

### 5.3 Quand le gap §4-3 sera résolu (futur)

Le diff sera **minimal** :

1. Supprimer le bloc `.field-warn` (lignes ~104-138 du JSX §4.3).
2. Activer la validation : `const canSpawn = nameValid && !!role && !submitting;`.
3. Ajouter un `submitting` state + un `onClick` qui appelle
   `props.onSpawn({ name: name.trim(), roleId, roleLabel: role.label, workerPreambleOverride: override.trim() || null })`.
4. Câbler `useOrchestrators().spawnWorker(orchId, …)` dans
   `DesktopShell` (à ajouter au hook quand l'API arrive).
5. Retirer le suffixe `(v2)` du bouton et le `title={GAP_TOOLTIP}`.

Aucun changement de layout, de champs, ou de comportement
utilisateur. C'est la garantie de l'approche preview-disabled.

---

## 6. `EditConfigDialog` — UI

### 6.1 Layout

```
┌─ modal (width: auto, max-width: 460px) ─────────────────────┐
│ ROTATE CONFIG  // NOMAD                                  ×  │
├─────────────────────────────────────────────────────────────┤
│ ⚠ Saving will restart all sessions in this team with the    │
│   new triplet.                                              │
│                                                             │
│ MODEL                                                       │
│ [opus-4-7                  ▾]                               │
│                                                             │
│ EFFORT                                                      │
│ [ low ][ medium ][ high* ][ xhigh ][ max ]                  │
│                                                             │
│ PERMISSION MODE                                             │
│ [bypassPermissions          ▾]                              │
│ ⚠ bypassPermissions :: agent runs unattended. No prompts.   │
│                                                             │
│ ┌─ field-warn (gap §4-2) ─────────────────────────────────┐ │
│ │ ⚠ available in v2 — PATCH /orchestrators/:id is not     │ │
│ │   implemented yet (plan §4-2). The button is disabled.  │ │
│ │                                                         │ │
│ │   Manual workaround: cancel, click STOP/KILL on this    │ │
│ │   team, then + NEW TEAM with the new triplet.           │ │
│ │   Note: destroy+recreate would lose session context,    │ │
│ │   inboxes, and changes the orchestrator id (URLs and    │ │
│ │   Discord notifications keyed on the old id will break).│ │
│ └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                       CANCEL  [ROTATE + RESTART →]disabled  │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Champs et défauts

| Champ | Type | Source default | Notes |
|---|---|---|---|
| `model` | dropdown `<select>` sur `MODELS` (cf. Step 9 §3) | `team.defaultModel` | Mêmes options qu'au NEW : `opus-4-7`, `sonnet-4-6`, `haiku-4-5`. Label raccourci via `.replace('claude-', '')`. |
| `effort` | `.seg-radio` sur `EFFORTS` | `team.defaultEffort` | 5 boutons pill, le sélectionné a la classe `on`. Cohérent avec NEW. |
| `perm` | dropdown sur `PERMS` | `team.defaultPermissionMode` | `bypassPermissions` déclenche un `.field-warn` inline (parité avec NEW). |

Aucun champ requis (les trois sont pré-remplis depuis la team
courante). Le bouton submit reste disabled v1 (cf. §6.4) ; pas de
validation à effectuer.

### 6.3 JSX final

```tsx
// packages/web/src/components/desktop/EditConfigDialog.tsx
import { useEffect, useState } from 'react';
import type { OrchestratorView } from '../../api/client';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PERMS = [
  'auto', 'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan',
] as const;
const MODELS = [
  { value: 'claude-opus-4-7', label: 'opus-4-7' },
  { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
  { value: 'claude-haiku-4-5-20251001', label: 'haiku-4-5' },
] as const;

interface Props {
  open: boolean;
  team: OrchestratorView | null;
  onClose: () => void;
  /** Reserved for v2 once PATCH /orchestrators/:id lands. Unused v1. */
  onSave?: (patch: {
    model: string;
    effort: (typeof EFFORTS)[number];
    permissionMode: (typeof PERMS)[number];
  }) => Promise<void>;
}

const GAP_TOOLTIP = 'available in v2 — see workaround below (gap §4-2)';

export default function EditConfigDialog({ open, team, onClose }: Props) {
  const [model, setModel] = useState<string>('claude-opus-4-7');
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('high');
  const [perm, setPerm] = useState<(typeof PERMS)[number]>('default');

  // Réinitialise à chaque (ré)ouverture, depuis la team courante
  useEffect(() => {
    if (open && team) {
      setModel(team.defaultModel);
      setEffort(team.defaultEffort);
      setPerm(team.defaultPermissionMode as (typeof PERMS)[number]);
    }
  }, [open, team]);

  // Esc → onClose
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !team) return null;

  // v1 : toujours disabled (gap §4-2).
  const canSave = false;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-config-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title" id="edit-config-title">
            ROTATE CONFIG{' '}
            <span className="sub">// {team.name}</span>
          </div>
          <button className="pr-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <div className="field-help" style={{ color: 'var(--warn)' }}>
            ⚠ Saving will restart all sessions in this team with the new triplet.
          </div>

          <div className="field">
            <label htmlFor="edit-model">MODEL</label>
            <select
              id="edit-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>EFFORT</label>
            <div className="seg-radio" role="radiogroup" aria-label="effort">
              {EFFORTS.map((ef) => (
                <button
                  key={ef}
                  type="button"
                  role="radio"
                  aria-checked={effort === ef}
                  className={effort === ef ? 'on' : ''}
                  onClick={() => setEffort(ef)}
                >
                  {ef}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="edit-perm">PERMISSION MODE</label>
            <select
              id="edit-perm"
              value={perm}
              onChange={(e) => setPerm(e.target.value as (typeof PERMS)[number])}
            >
              {PERMS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {perm === 'bypassPermissions' && (
              <div className="field-warn">
                ⚠ bypassPermissions :: agent runs unattended. No permission prompts.
              </div>
            )}
          </div>

          {/* gap §4-2 disclosure */}
          <div className="field-warn">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              ⚠ available in v2 — backend endpoint missing
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.55 }}>
              <code>PATCH /orchestrators/:id</code> is not implemented yet
              (plan §4-2). The button below is disabled.
              <br />
              <span style={{ color: 'var(--text-mute)' }}>
                Manual workaround: cancel, click <b>STOP</b> (or <b>KILL</b>)
                on this team, then <b>+ NEW TEAM</b> with the new triplet.
              </span>
              <div
                style={{
                  marginTop: 6,
                  padding: '6px 8px',
                  background: 'rgba(232,176,74,0.06)',
                  borderLeft: '2px solid var(--bad)',
                  fontSize: 10.5,
                  color: 'var(--text-dim)',
                }}
              >
                <b style={{ color: 'var(--bad)' }}>destroy+recreate would lose:</b>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  <li>lead session context (LLM history, MCP cache, edits in flight)</li>
                  <li>all worker sessions and their mailboxes</li>
                  <li>the orchestrator id — URLs (<code>#/orchestrators/:id</code>)
                      and Discord webhook keys will break</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>CANCEL</button>
          <button
            className="btn primary"
            disabled={!canSave}
            style={{ opacity: 0.4, cursor: 'not-allowed' }}
            title={GAP_TOOLTIP}
            aria-disabled="true"
          >
            ROTATE + RESTART → <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>(v2)</span>
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 6.4 Notes d'implémentation

- **Pré-remplissage depuis `team.default*`** : à chaque (ré)ouverture
  via `useEffect([open, team])`. Si l'opérateur change la team active
  pendant que la modale est ouverte (peu probable, le `RightPanel`
  est fermé pendant l'overlay), le `team` prop change → reset.
- **`canSave` codé en dur à `false`** : même approche que `canSpawn`
  ; quand le gap §4-2 sera résolu, remplacer par `true` (ou par une
  comparaison `(model !== team.defaultModel || effort !== … || perm !== …) && !submitting`).
- **Pas de validation côté UI** : les trois champs sont déjà pré-remplis
  et toujours valides (pas de string vide possible).
- **Le `bypassPermissions` warn inline** est conservé pour la cohérence
  visuelle avec `NewOrchestratorDialog` même si l'opérateur ne peut
  pas valider — informer reste utile.
- **Casting `team.defaultPermissionMode as (typeof PERMS)[number]`** :
  le type backend (`string`) est plus lâche que l'enum frontend. En
  pratique le serveur n'émet que des valeurs du set ; cast safe.

---

## 7. `EditConfigDialog` — comportement (disabled vs workaround)

### 7.1 Choix retenu : disabled + workaround documenté in-modal

Identique à §5.1 : bouton toujours disabled v1, `field-warn`
documente la procédure manuelle destroy+recreate, **avec
l'avertissement explicite des pertes induites** (contexte session,
inboxes, id).

### 7.2 Alternative envisagée (rejetée) : destroy+recreate automatique

Le frontend pourrait, en deux appels REST, faire :

```ts
async function rotate(team, patch) {
  // 1. snapshot du contexte minimal
  const snapshot = {
    name: team.name,
    role: team.role,
    roleId: team.roleId,
    cwd: team.sessions.find(s => s.type === 'lead')?.cwd ?? '/',
    leadPreamble: team.leadPreamble,
    workerPreamble: team.workerPreamble,
  };
  // 2. destroy
  await api.destroyOrchestrator(team.id);
  // 3. recreate avec le nouveau triplet
  return api.createOrchestrator({
    name: snapshot.name,
    roleId: snapshot.roleId,
    lead: { cwd: snapshot.cwd, preamble: snapshot.leadPreamble ?? undefined },
    workerPreamble: snapshot.workerPreamble ?? undefined,
    defaults: patch,
  });
}
```

**Pourquoi rejeté** :

- **Pas de récupération du `leadPrompt` initial** : le serveur ne
  l'expose pas dans `OrchestratorView` (il a été consommé par le lead
  au démarrage). Le nouveau lead démarrerait sans prompt → comportement
  différent.
- **Pas de récupération des workers** : `OrchestratorView.sessions`
  contient leurs noms/roles/preambles, mais pas les prompts d'origine
  (pareillement consommés). Recréer manuellement les workers
  perdrait leur contexte et leurs prompts spécifiques.
- **Inboxes vidées** : tous les messages non-lus disparaissent
  (cf. comportement de `destroyOrchestrator` qui détruit le mailbox).
- **Id change** : c'est l'effet de bord le plus visible — les URLs
  partagées, les Discord webhooks ciblant l'ancien id, les références
  externes cassent.
- **Pas d'undo** : si la recréation échoue (validation cwd qui a
  bougé, role supprimé entre-temps), l'opérateur a perdu son équipe
  sans alternative.

L'UI ne peut pas honnêtement appeler ça "ROTATE + RESTART" — c'est
en réalité un `STOP + NEW TEAM` orchestré par le frontend, avec moins
de garanties que si l'opérateur le faisait à la main (au moins lui,
il garde la trace de ce qu'il vient de faire).

### 7.3 Synthèse

| Critère | destroy+recreate auto (rejeté) | Disabled + workaround manuel (retenu) |
|---|---|---|
| Fidélité à la team d'origine | Partielle (prompt perdu, workers perdus) | L'opérateur recrée explicitement ce qu'il veut |
| Préservation du contexte LLM | Aucune | Aucune (mais explicite) |
| Préservation des inboxes | Aucune | Aucune (mais explicite) |
| Préservation de l'id | Non | Non (mais explicite) |
| Annulation possible | Non (destructif immédiat) | Oui (l'opérateur ne clique pas) |
| Cohérence labelling | "ROTATE" trompeur | "v2 — see workaround" honnête |
| Visibilité dans l'historique | `killed` + nouveau orchestrator (bruit) | Idem mais l'opérateur le sait |

### 7.4 Quand le gap §4-2 sera résolu (futur)

1. Supprimer le bloc `.field-warn` du gap §4-2 (lignes ~110-145 du JSX §6.3).
2. Activer `canSave = (model !== team.defaultModel || effort !== team.defaultEffort || perm !== team.defaultPermissionMode) && !submitting;`.
3. Ajouter `onClick={() => onSave({ model, effort, permissionMode: perm })}` avec un `submitting` state.
4. Câbler `useOrchestrators().patchConfig(orchId, patch)` dans `DesktopShell`.
5. Retirer le `(v2)` du bouton et le `title={GAP_TOOLTIP}`.

---

## 8. Tooltips et messaging — synthèse opérateur

L'opérateur doit comprendre, en moins de 5 secondes, trois choses :

1. **Ce bouton ne fait rien aujourd'hui** (disabled visible : `opacity:
   0.4`, `cursor: not-allowed`, suffixe `(v2)` discret).
2. **Pourquoi** (`available in v2`, mention du gap `§4-2` / `§4-3` et de
   l'endpoint manquant pour les lecteurs techniques).
3. **Ce qu'il peut faire à la place** (workaround manuel, copy-paste
   prêt pour `SpawnWorker`, procédure en deux étapes pour `EditConfig`
   + énoncé clair des pertes induites).

### 8.1 Tableau des textes exacts

| Emplacement | Texte exact |
|---|---|
| `SpawnWorker` — `title` du bouton | `available in v2 — see workaround below (gap §4-3)` |
| `SpawnWorker` — entête du `field-warn` | `⚠ available in v2 — backend endpoint missing` |
| `SpawnWorker` — corps du `field-warn` | `POST /orchestrators/:id/workers is not implemented yet (plan §4-3). The button below is disabled. Manual workaround: cancel, open the TEAM composer on this lead, and broadcast: <template MCP>. The lead will receive it in its mailbox and may invoke the MCP tool. No acknowledgement is returned to the UI; the new session will appear in MapView once spawned.` |
| `SpawnWorker` — suffixe du bouton | `SPAWN → (v2)` |
| `EditConfig` — `title` du bouton | `available in v2 — see workaround below (gap §4-2)` |
| `EditConfig` — entête du `field-warn` | `⚠ available in v2 — backend endpoint missing` |
| `EditConfig` — corps du `field-warn` | `PATCH /orchestrators/:id is not implemented yet (plan §4-2). The button below is disabled. Manual workaround: cancel, click STOP (or KILL) on this team, then + NEW TEAM with the new triplet. destroy+recreate would lose: lead session context (LLM history, MCP cache, edits in flight) ; all worker sessions and their mailboxes ; the orchestrator id — URLs and Discord webhook keys will break.` |
| `EditConfig` — suffixe du bouton | `ROTATE + RESTART → (v2)` |

### 8.2 Conventions visuelles

- **`field-warn` du gap** : même classe que les autres warnings de
  l'app (`bypassPermissions`, etc.). Bord gauche ambré, fond
  `rgba(232,176,74,0.06)`. Pas de classe spécifique "gap-disclosure" —
  on réutilise.
- **Encart de workaround MCP** (`SpawnWorker`) : monospace
  (`Geist Mono`), fond ambré 6% opacity, bord gauche ambré 2 px,
  texte `var(--text)` (pleine intensité — c'est le truc à copier).
- **Encart des pertes** (`EditConfig`) : monospace optionnel,
  bord gauche **rouge** (`var(--bad)` 2 px) parce que ce sont des
  conséquences destructives. Liste à puces lisible.
- **Bouton disabled** : `opacity: 0.4`, `cursor: 'not-allowed'`,
  `aria-disabled="true"`, **pas** d'`onClick` (pas même un no-op —
  React ignore les clics sur `disabled` mais on est explicites).
- **Suffixe `(v2)` sur le bouton** : `<span style={{ color:
  'var(--text-mute)', fontSize: 10 }}>(v2)</span>` — petit, discret,
  visible. Sert de signal à distance ("ah, c'est preview").

### 8.3 Pas de toast ni notif

Pas de toast `you can't do that yet` quand l'opérateur clique sur le
bouton disabled — le bouton est *physiquement* non-cliquable, et le
`title` HTML standard fait le travail au hover. Ajouter une notif
serait du bruit (l'opérateur sait, il a vu le `field-warn`).

---

## 9. Câblage — où ouvrir/fermer les modales

### 9.1 États dans `DesktopShell`

Hérités de Step 2 (préfixés `_` actuellement, à dépréfixer ici puisqu'on
les consomme) :

```tsx
// packages/web/src/components/desktop/DesktopShell.tsx (extrait)
const [spawnFor, setSpawnFor] = useState<OrchestratorView | null>(null);
const [editConfigFor, setEditConfigFor] = useState<OrchestratorView | null>(null);
```

**Forme du state** : `OrchestratorView | null` (pas `RightPanelTeam`
— ce dernier est un type dérivé spécifique au `RightPanel`, alors
que les modales lisent directement les champs `defaultModel`,
`defaultEffort`, `defaultPermissionMode`, `name` de l'orchestrator
serveur, plus le `workerPreamble` du role pour le placeholder
`SpawnWorker`). L'adapter `buildRightPanelTeam` (Step 7 §3.1) reste
utile pour le `RightPanel` mais inutile ici.

### 9.2 Points d'ouverture (call-sites des setters)

**`RightPanel` (Step 7)** — déjà câblé :

- **`+ WORKER`** button → `onSpawnWorker(team)` →
  `setSpawnFor(orchView)` au niveau `DesktopShell`. Le bouton est
  `disabled={!isLead || stopped || isFailed}` (cf. proto `panels.jsx:323`)
  — seul un lead actif peut spawn (sémantique métier, indépendante
  du gap §4-3). Si l'opérateur clique malgré tout sur un worker, le
  `title="lead-only action"` du proto reste en place.
- **Edit pencil** sur `.pr-cfgline` → `onEditConfig(team)` →
  `setEditConfigFor(orchView)`. Le pencil n'a pas de critère
  `disabled` (le proto le rend cliquable même sur des teams en
  `stopped`/`failed`, puisque la modale a un sens même pour ces
  états — l'opérateur veut rotater puis relancer ; mais le bouton
  submit reste disabled v1 de toute façon, donc no harm).

**Mapping prop → state** dans `DesktopShell` :

```tsx
<RightPanel
  …
  onSpawnWorker={(team) => {
    // team est de type RightPanelTeam, on retrouve l'OrchestratorView
    const orch = orchestrators.find((o) => o.id === team.id);
    if (orch) setSpawnFor(orch);
  }}
  onEditConfig={(team) => {
    const orch = orchestrators.find((o) => o.id === team.id);
    if (orch) setEditConfigFor(orch);
  }}
/>
```

(Variante : remonter directement l'`OrchestratorView` via le `RightPanelTeam`
si on ajoute un champ `_raw: OrchestratorView` au type — mais ça pollue
l'adapter. Le `find` est cheap, on garde.)

### 9.3 Montage des modales

Juste après les autres overlays (Step 9-12), avant les toasts :

```tsx
// packages/web/src/components/desktop/DesktopShell.tsx (extrait)
import SpawnWorkerDialog from './SpawnWorkerDialog';
import EditConfigDialog from './EditConfigDialog';
import { useRoles } from '../../hooks/useRoles';

// …
const { roles } = useRoles();

return (
  <div className="app">
    {/* … TopBar / LeftPanel / MapView / RightPanel … */}

    {/* Phase C overlays */}
    {/* … NewOrchestratorDialog (Step 9) … */}
    {/* … RolesPage (Step 10) … */}
    {/* … SettingsDrawer (Step 11) … */}
    {/* … BroadcastModal (Step 12) … */}

    <SpawnWorkerDialog
      open={spawnFor !== null}
      team={spawnFor}
      roles={roles}
      onClose={() => setSpawnFor(null)}
      // onSpawn non passé v1
    />
    <EditConfigDialog
      open={editConfigFor !== null}
      team={editConfigFor}
      onClose={() => setEditConfigFor(null)}
      // onSave non passé v1
    />

    {/* … Toasts / EventsPip … */}
  </div>
);
```

### 9.4 Points de fermeture

- Clic sur le backdrop (`.modal-backdrop > onClick={onClose}`).
- Clic sur la croix `×` (`.pr-close`).
- Clic sur `CANCEL` (`.btn.ghost`).
- Touche `Esc` (gérée via `useEffect([open], onClose)` interne au
  composant, parité avec `BroadcastModal` Step 12).
- **Pas** de fermeture sur submit (bouton submit disabled, jamais
  cliqué).

### 9.5 Refresh `roles` quand `SpawnWorkerDialog` est ouvert

`useRoles()` poll 5 s — la dropdown role se mettra à jour
automatiquement si l'opérateur a créé un role pendant que la modale
était ouverte (cas marginal). Si la sélection actuelle (`roleId`)
disparaît du nouveau set, le `find` renvoie `undefined` et le `role`
local devient `workerRoles[0]` — comportement acceptable. **Pas
besoin** de gérer explicitement.

### 9.6 Pas de double ouverture simultanée

Les deux modales sont indépendantes côté state, mais en pratique
l'opérateur n'en ouvre qu'une à la fois (les deux boutons sont dans
le `RightPanel`, et seul un est cliquable à la fois selon le
contexte). Si l'opérateur force la situation (DevTools), les deux
backdrops se cumulent — cas dégénéré, à ne pas optimiser. **Note** :
si on voulait être strict, ajouter un `useEffect` qui ferme
`editConfigFor` quand `spawnFor` s'ouvre et inversement — pas
nécessaire en pratique.

---

## 10. Plan d'implémentation pas-à-pas

1. **Pré-vol** : vérifier que
   - `desktop-theme.css` (Step 1) expose toutes les classes du §6.1
     (modal*, field*, btn*, pr-close, seg-radio, dot, code) et les
     variables (`--amber`, `--warn`, `--bad`, `--text`, `--text-dim`,
     `--text-mute`) ;
   - `SpawnWorkerDialog.tsx` et `EditConfigDialog.tsx` existent en stub
     (Step 2) avec `export default function … () { return null; }` ;
   - `DesktopShell.tsx` a déjà les states `spawnFor` / `editConfigFor`
     (depuis Step 2), même si destructurés sans getter — il faudra
     juste dépréfixer ;
   - `RightPanel.tsx` (Step 7) câble bien `onSpawnWorker` et
     `onEditConfig` sur les bons boutons (vérifier par lecture).
2. **Centraliser `MODELS` / `EFFORTS` / `PERMS`** (cf. §11 note) — si pas
   encore fait, créer `packages/web/src/components/desktop/constants.ts`
   avec les trois constantes typées (sourcées de Step 9), et les importer
   dans `EditConfigDialog`. Sinon, dupliquer inline (acceptable v1).
3. **Réécriture intégrale de `SpawnWorkerDialog.tsx`** avec le code §4.3.
   - Importer `OrchestratorView`, `RoleView` depuis `../../api/client`.
   - Conserver l'`export default function SpawnWorkerDialog`.
   - Vérifier que `useRoles` ne soit **pas** appelé en interne (les
     `roles` sont passés en prop depuis `DesktopShell`).
4. **Réécriture intégrale de `EditConfigDialog.tsx`** avec le code §6.3.
   - Importer `OrchestratorView` depuis `../../api/client`.
   - Conserver l'`export default`.
   - Importer les constantes (ou inliner).
5. **Câblage dans `DesktopShell.tsx`** :
   - Dépréfixer `setSpawnFor` / `setEditConfigFor` (passer de
     `const [, setSpawnFor]` à `const [spawnFor, setSpawnFor]`).
   - Changer le type du state de `RightPanelTeam | null` à
     `OrchestratorView | null` (et idem `editConfigFor`).
   - Importer `useRoles` (déjà importé si Step 9 ou 10 l'a introduit).
   - Adapter les callbacks `onSpawnWorker` / `onEditConfig` pour faire
     le `find` sur `orchestrators` (cf. §9.2).
   - Monter les deux modales dans la zone overlays (cf. §9.3).
6. **TS check** : `pnpm tsc --noEmit` depuis `packages/web/` — corriger
   les éventuelles erreurs de typing (cast `PermissionMode`, prop
   `onSpawn`/`onSave` optionnelles non-passées, etc.).
7. **Lint** : `pnpm lint` — au minimum vérifier `no-unused-vars` (le
   prop `onSpawn` non utilisé est documenté comme `Reserved for v2`,
   ESLint peut grogner — annoter `// eslint-disable-next-line @typescript-eslint/no-unused-vars`
   sur la déclaration de prop ou destructurer dans la signature).
8. **Tests Vitest** (nouveaux fichiers) :
   - `SpawnWorkerDialog.test.tsx` :
     - rendu when `open=true` avec une team + 3 roles dont 1 ORCHESTRATOR
       → la dropdown a 2 entrées (ORCHESTRATOR filtré) ;
     - bouton SPAWN toujours disabled, même quand `name` rempli ;
     - tooltip `available in v2` présent sur le bouton ;
     - le `field-warn` contient `POST /orchestrators/:id/workers` ;
     - le template MCP reflète le `name` saisi ;
     - clic backdrop → `onClose` ;
     - clic CANCEL → `onClose` ;
     - Esc → `onClose`.
   - `EditConfigDialog.test.tsx` :
     - rendu when `open=true` avec une team aux valeurs `opus-4-7 /
       high / default` → les trois champs sont pré-remplis ;
     - bouton ROTATE+RESTART toujours disabled ;
     - tooltip `available in v2` présent ;
     - le `field-warn` contient `PATCH /orchestrators/:id` ;
     - sélectionner `bypassPermissions` → warn inline apparaît ;
     - changer une valeur ne change pas le `disabled` du bouton ;
     - clic backdrop / CANCEL / Esc → `onClose`.
9. **QA visuelle** (`docker build -t swarm-os:latest .` puis
   `docker compose -f docker-compose.test.yml up -d` cf. mémoire
   `project_docker_redeploy.md`) : exécuter les tests de fumée §12.
10. **Documentation** : aucune modification à
    `docs/ui-redesign-desktop.md` (le présent doc est le détail
    référencé par §5.1 step 13). Si on veut, ajouter une ligne dans
    §3.5 du plan parent : `| SpawnWorkerDialog | … | ⚠ v1 disabled +
    workaround MCP via PTY documenté (cf. C.13) |` — mais c'est déjà
    impliqué par la mention "gap §4-3".
11. **Suivi (follow-ups)** :
    - Issue "S13 — `POST /orchestrators/:id/workers`" (gap §4-3) — pour
      permettre le spawn depuis l'opérateur (sans passer par le lead).
    - Issue "S14 — `PATCH /orchestrators/:id`" (gap §4-2) — pour
      permettre la rotation atomique sans destroy+recreate.
    - Issue "UI — retirer les `field-warn` de gap quand S13/S14 livrent"
      — checklist 5 lignes par modale.

---

## 11. Points d'attention

1. **Constantes `MODELS`/`EFFORTS`/`PERMS` dupliquées** : actuellement
   définies inline dans `NewOrchestratorDialog.tsx` (cf. Step 9 §3) et
   dans `EditConfigDialog.tsx` (cette étape). Idéalement, à extraire
   dans `packages/web/src/components/desktop/constants.ts` avec un
   `export const MODELS = […]` etc. À programmer en sus de Step 9 si
   non fait. Sans préjudice fonctionnel v1.
2. **Filtre `roles.filter(r => r.label !== 'ORCHESTRATOR')`** : le
   proto v2 utilise un filtre par label exact. Alternative plus
   robuste : `r.workerCount === null || r.workerCount > 0` (un role
   destiné aux workers, par opposition aux roles ORCHESTRATOR-only).
   **Décision v1** : on garde le filtre par label (parité proto) ;
   c'est facile à ajuster plus tard.
3. **`team.defaultPermissionMode` cast** : le backend type ce champ
   `string`, le frontend `(typeof PERMS)[number]`. Si le serveur émet
   une valeur hors enum (cas théorique, jamais constaté), le
   `<select>` affichera le `defaultValue` natif mais aucune `<option>`
   correspondante — l'option apparaîtra "vide". À monitorer ; si
   constaté, ajouter une `<option>` fallback.
4. **`team.defaultModel.replace('claude-', '')`** dans le `field-help`
   de `SpawnWorker` : si le serveur introduit un modèle sans préfixe
   `claude-` (futur), le `.replace` est no-op — pas de bug, juste un
   label moins court. Acceptable.
5. **A11y `aria-disabled` vs `disabled`** : on utilise les deux. `disabled`
   pour bloquer effectivement le clic (rétro-compat assistive tech) ;
   `aria-disabled="true"` pour le rendre lisible par les SR comme
   "désactivé" tout en restant focusable (intéressant si on veut que
   le `title` soit annoncé via `aria-describedby`). À surveiller en
   audit a11y ; si conflit, garder `disabled` uniquement.
6. **Workaround MCP template** : le snippet dans le `field-warn` de
   `SpawnWorker` est intentionnellement minimal (`name`, `role`,
   `prompt="<your task here>"`). On n'inclut pas `cwd`, `model`,
   `effort`, `permissionMode` (optionnels — hériteront du lead).
   L'opérateur les ajoutera s'il en a besoin.
7. **Persistance entre ouvertures** : non. Chaque ouverture remet
   les champs à leurs défauts (vide ou valeur de la team). Comportement
   parité prototype.
8. **Focus restoration** : à la fermeture, focus retourne sur le
   bouton qui a ouvert la modale (le `+ WORKER` ou le pencil). À
   implémenter via une `ref` côté `RightPanel` + un effet de
   restoration — non-bloquant v1, follow-up générique `useModal` (cf.
   Step 12 §11).
9. **Performance** : composants statiques, aucun risque. Le `roles`
   prop change toutes les 5 s (poll) → re-render du `SpawnWorkerDialog`
   à chaque tick. Si problème (rare), `React.memo` est trivial à
   ajouter.
10. **z-index** : `.modal-backdrop` (z-index ~100, défini Step 1) au
    dessus du RightPanel, sous les toasts (~200). Vérifier en QA.
11. **Coexistence avec d'autres modales** : si l'opérateur ouvre
    `NewOrchestratorDialog` (TopBar) puis `SpawnWorkerDialog`
    (RightPanel) sans fermer le premier, les deux backdrops se
    cumulent. Cas dégénéré, non-optimisé. Variante stricte : un
    `useEffect` global qui force un seul overlay à la fois — non
    retenu (complexité disproportionnée).

---

## 12. Tests de fumée

À jouer manuellement dans l'app dockerisée après build
(`docker build -t swarm-os:latest .` + `docker compose -f
docker-compose.test.yml up -d`, cf. mémoire user
`project_docker_redeploy.md`).

### 12.1 `SpawnWorkerDialog`

1. **Pré-requis** : avoir au moins une team active avec un lead, et au
   moins 2 roles dont 1 différent de ORCHESTRATOR.
2. **Ouverture depuis un lead** : sélectionner le lead dans MapView →
   RightPanel s'ouvre → cliquer `+ WORKER` → modale apparaît, titre
   `+ SPAWN WORKER // in <team.name>`, dropdown ROLE filtrée
   (ORCHESTRATOR absent), MODEL/EFFORT/PERM dans le `.field-help`
   reflètent la team, encart `field-warn` gap §4-3 visible avec
   template MCP.
3. **Ouverture depuis un worker** : sélectionner un worker → bouton
   `+ WORKER` est `disabled` (tooltip "lead-only action"). Cliquer ne
   fait rien. **Modale ne s'ouvre pas**.
4. **Saisie name** : taper `probe-04` dans NAME → le champ affiche
   `PROBE-04` (auto-uppercase). Le template MCP du `field-warn`
   reflète `name="PROBE-04"`.
5. **Saisie name vide** : vider NAME → template MCP retombe sur
   `name="PROBE-04"` (placeholder par défaut). Bouton SPAWN reste
   disabled (de toute façon).
6. **Changement de role** : sélectionner BUILDER puis RESEARCHER →
   placeholder du textarea OVERRIDE change selon
   `role.workerPreamble`. Template MCP reflète le nouveau `role=…`.
7. **Bouton SPAWN disabled** : peu importe la saisie, le bouton
   `SPAWN → (v2)` reste disabled, `opacity: 0.4`, `cursor:
   not-allowed`. Hover affiche tooltip `available in v2 — see
   workaround below (gap §4-3)`.
8. **Clic SPAWN** : aucun effet (bouton disabled). Aucune requête
   réseau dans DevTools Network.
9. **CANCEL** : ferme la modale, retour au RightPanel.
10. **Backdrop click** : ferme.
11. **Esc** : ferme.
12. **Croix `×`** : ferme.
13. **Réouverture** : tous les champs sont remis à leurs défauts
    (NAME vide, role = premier non-ORCHESTRATOR, override vide).
14. **Pendant que la modale est ouverte, créer un role** (via
    `+ NEW TEAM` ou directement Roles page) : la dropdown se met à
    jour dans les 5 s suivantes (poll `useRoles`).
15. **Workaround MCP** : copier le template du `field-warn`, fermer
    la modale, ouvrir le composer TEAM du lead, coller → envoyer.
    Vérifier que le lead reçoit le message dans son mailbox
    (`peekInbox`). Le lead peut (ou non) invoquer `team.spawn_worker`
    — comportement attendu : la modale n'avait aucune part dans cette
    action.

### 12.2 `EditConfigDialog`

1. **Pré-requis** : au moins une team active.
2. **Ouverture depuis le pencil** : sélectionner la team → RightPanel
   → cliquer le pencil sur la `.pr-cfgline` → modale apparaît, titre
   `ROTATE CONFIG // <team.name>`, les trois champs sont pré-remplis
   depuis `team.default{Model,Effort,PermissionMode}`.
3. **Warning header** : `⚠ Saving will restart all sessions in this
   team with the new triplet.` visible.
4. **Changement MODEL** : ouvrir la dropdown, voir les 3 options
   raccourcies (`opus-4-7`, `sonnet-4-6`, `haiku-4-5`). Sélectionner
   `sonnet-4-6`. Le bouton reste disabled.
5. **Changement EFFORT** : cliquer chaque pill du `.seg-radio`. Le
   pill sélectionné a la classe `on` (visuellement actif).
6. **Changement PERM = bypassPermissions** : sélectionner →
   `.field-warn` inline apparaît avec `⚠ bypassPermissions :: agent
   runs unattended.`. Changer pour `default` → le warn disparaît.
7. **Encart gap §4-2** : visible, contient `PATCH /orchestrators/:id`,
   liste des pertes (lead session context, workers/mailboxes, id /
   URLs / Discord). Bordure gauche rouge.
8. **Bouton ROTATE+RESTART disabled** : indépendamment des
   changements, bouton `ROTATE + RESTART → (v2)` reste disabled,
   tooltip `available in v2 — see workaround below (gap §4-2)`.
9. **Clic bouton** : aucun effet.
10. **CANCEL / backdrop / Esc / `×`** : ferment.
11. **Réouverture après changement** : si l'opérateur a modifié des
    valeurs puis fermé sans submit, à la réouverture les champs sont
    re-remplis depuis `team.default*` (pas de persistance).
12. **Ouverture depuis une team `stopped`/`failed`** : la modale
    s'ouvre quand même (pencil sans restriction de status). Champs
    pré-remplis depuis les anciennes valeurs de la team. Bouton
    disabled (comme toujours v1).
13. **Workaround manuel** : fermer la modale, cliquer STOP/KILL sur
    le team (avec `ConfirmModal`), puis `+ NEW TEAM` dans la TopBar
    avec le nouveau triplet. Vérifier que la nouvelle team apparaît,
    avec un id différent.

### 12.3 Combinés

1. **Aucune régression du `RightPanel`** : ouvrir et fermer chaque
   modale, vérifier que les autres tabs (CONSOLE, MESSAGES, CONFIG),
   actions (STOP/PAUSE/RESTART/KILL/REACTIVATE), composer
   (PTY/INBOX, AGENT/TEAM) restent fonctionnels.
2. **Pas de log d'erreur console** : DevTools Console doit être
   clean (pas de warning React, pas d'erreur 404 réseau).
3. **Aucune requête réseau** générée par l'ouverture/fermeture des
   modales (sauf `useRoles` poll, qui tournait déjà).
4. **A11y screen reader** (optionnel) : naviguer au pencil avec Tab,
   Enter ouvre la modale. Focus arrive sur le premier champ (MODEL
   dropdown). Le `aria-disabled="true"` du bouton est annoncé. Esc
   ferme.
5. **Build prod** : `pnpm build` depuis `packages/web/` passe sans
   erreur.

---

## 13. Récap des fichiers touchés

| Fichier | Action |
|---|---|
| `packages/web/src/components/desktop/SpawnWorkerDialog.tsx` | **Réécriture intégrale** depuis le stub Step 2 (code §4.3) |
| `packages/web/src/components/desktop/EditConfigDialog.tsx` | **Réécriture intégrale** depuis le stub Step 2 (code §6.3) |
| `packages/web/src/components/desktop/DesktopShell.tsx` | Dépréfixer `setSpawnFor`/`setEditConfigFor`, changer type state `OrchestratorView \| null`, importer `useRoles`, monter les deux modales dans la zone overlays, adapter les callbacks `onSpawnWorker`/`onEditConfig` pour faire le `find` sur `orchestrators` (cf. §9) |
| `packages/web/src/components/desktop/SpawnWorkerDialog.test.tsx` | **Nouveau fichier** — tests Vitest (cf. §10 step 8) |
| `packages/web/src/components/desktop/EditConfigDialog.test.tsx` | **Nouveau fichier** — tests Vitest (cf. §10 step 8) |
| `packages/web/src/components/desktop/constants.ts` | **Nouveau (optionnel)** — extraction `MODELS`/`EFFORTS`/`PERMS` (cf. §11 note 1) |
| `packages/web/src/components/desktop/RightPanel.tsx` | **Aucun changement** (props `onSpawnWorker`/`onEditConfig` déjà câblées Step 7) |
| `packages/web/src/components/desktop/MapView.tsx` | **Aucun changement** |
| `packages/web/src/styles/desktop-theme.css` | **Aucun changement** (toutes les classes existent déjà Step 1) |
| `packages/web/src/api/client.ts` | **Aucun changement** (aucun nouveau endpoint v1) |
| `packages/web/src/hooks/useRoles.ts` | **Aucun changement** (déjà câblé Step 9/10) |
| `packages/web/src/hooks/useOrchestrators.ts` | **Aucun changement** v1 ; futur S13/S14 ajoutera `spawnWorker(orchId, …)` / `patchConfig(orchId, …)` |

---

## 14. Ce que cette étape NE fait PAS

- Pas d'endpoint serveur `POST /orchestrators/:id/workers` (gap §4-3,
  follow-up S13).
- Pas d'endpoint serveur `PATCH /orchestrators/:id` (gap §4-2,
  follow-up S14).
- Pas de proxy MCP REST côté serveur (les MCP tools restent
  strictement intra-agent — cf. §3.1).
- Pas d'exécution automatique du workaround (ni broadcast MCP via PTY,
  ni destroy+recreate) — les workarounds sont **documentés** dans les
  modales, pas exécutés par le bouton submit.
- Pas de retry, persistance, ou undo (rien à retry/persister/undo, le
  bouton est disabled).
- Pas de hook `useModal` partagé (extraction Esc + focus restoration
  — follow-up générique Step 12 §11).
- Pas de modification du `RightPanel` (boutons et props déjà OK
  depuis Step 7).
- Pas de gestion du cas `team !== null && team.endedAt !== null` —
  les modales s'ouvrent quand même, c'est fonctionnellement neutre v1
  (bouton disabled). Quand les endpoints arriveront, ajouter un
  guard `disabled={team.endedAt !== null}` ou similaire.
