# Étape 9 (Phase C.9) — Port de `NewOrchestratorDialog` v2

> **Périmètre exact** : remplacer le `NewOrchestratorDialog` actuel
> (Tailwind, `bg-slate-900`, layout 2-cols) par la version v2 du prototype
> (`prototypes/v2/modals.jsx:4-117`) avec le thème warm-black ambré, la
> dropdown `+ create new role…` qui ouvre `RoleDialog` inline, et le
> warning ambré sur `permissionMode === 'bypassPermissions'`.
> Backend : aucun changement — `POST /orchestrators` (S5/S6) reste l'unique
> appel, exposé via `api.createOrchestrator` et propagé par
> `useOrchestrators.create`.

---

## 1. Objectif

Aligner la modale de création d'orchestrator sur la charte v2 (Geist Mono,
amber `#e8b04a`, surfaces `--panel-solid`), préserver toute la logique
fonctionnelle existante (mêmes champs, mêmes contrats vers le backend,
mêmes auto-remplissages depuis un role sélectionné), et conserver les
deux affordances UX héritées : (a) bouton `+ create new role…` qui ouvre
`RoleDialog` en surimpression, (b) warning visible quand l'opérateur
choisit `bypassPermissions`. Le composant reste pilotable de façon
contrôlée par `OrchestratorList.tsx` (puis, plus tard, `DesktopShell`)
via `{open, onClose, onCreate}`.

---

## 2. Diff fonctionnel

| Aspect | Existant (`NewOrchestratorDialog.tsx`) | v2 cible |
|---|---|---|
| **Stack visuelle** | Tailwind 4 (`bg-slate-900`, `border-slate-700`, `rounded-lg`) | Classes utilitaires v2 (`.modal-backdrop`, `.modal.wide`, `.modal-head`, `.modal-body`, `.modal-foot`, `.field`, `.field-row`, `.field-3`, `.seg-radio`, `.btn.primary`, `.btn.ghost`, `.field-warn`) définies dans `desktop-theme.css` (Étape 1) |
| **Titre** | "New orchestrator" `<h2>` | `+ NEW ORCHESTRATOR` Geist Mono + `// spin up a new team` en sub (`.modal-title .sub`) |
| **Backdrop clic** | Pas de fermeture au clic (overlay décoratif) | Clic backdrop → `onClose()` ; clic dans `.modal` → `e.stopPropagation()` (parité prototype) |
| **Bouton close** | Absent (fermeture par Cancel ou ESC) | Croix `×` en haut à droite (`.pr-close`) qui appelle `onClose()` |
| **Champ NAME** | `input` libre, default `'smoke'` | `input autoFocus`, placeholder `e.g. NOMAD` ; le proto force `toUpperCase()` à la soumission — à appliquer également (parité backend `OrchestratorView.name` stocké tel quel) |
| **Champ ROLE** | `select` + input `role` libre quand `(no role)` | `select` strict, premier role = sélection par défaut (`roles[0]?.id`). **Pas de label libre** en v2 — si l'opérateur veut une étiquette custom, il passe par "+ create new role…". |
| **Sentinelle "+ create new role"** | `__create_new__` (CREATE_ROLE_SENTINEL), ouvre `RoleDialog` | Conservée : valeur `__new__` (cf. proto `modals.jsx:58`), ouvre `RoleDialog` ; à la résolution → la nouvelle role est sélectionnée dans la dropdown |
| **Champ CWD** | `cwd` requis, placeholder `/mon-projet`, default `''` | `cwd` requis, placeholder `/workspace/path`, default `'/swarm-fyrel/'` (proto) ; default à conserver tel quel (le user le retape s'il veut), + ligne `.field-help` "workspace-relative path the lead will operate from" |
| **Champ LEAD PROMPT** | textarea requis, default `'say hi'`, `h-24 font-mono text-xs` | textarea requis, default `''`, placeholder `Initial task for the lead. e.g. "Ship the new swarm.bin under the new constraints."`; bordure Geist Mono `--panel-solid` |
| **Champ LEAD PREAMBLE** | textarea optionnel, vide par défaut, `h-20` | textarea optionnel, label `LEAD PREAMBLE // optional`, placeholder `System preamble injected before the lead prompt. Defaults from the role.` |
| **MODEL / EFFORT / PERMISSION** | 3 `<select>` séparés sur une grille `grid-cols-2` | Bloc `.field-3` (3 colonnes) : MODEL `<select>` (labels raccourcis via `.replace('claude-', '')`) · EFFORT en `.seg-radio` (boutons pill ON/OFF) · PERMISSION `<select>` |
| **Auto-fill depuis role** | `useEffect([selectedRole])` — réécrit prompt/preamble/model/effort/perm dès qu'un role est sélectionné | Idem v2 : `useEffect([roleId])` — réécrit model/effort/perm systématiquement, préamble **uniquement si vide** (`if (!preamble && role.leadPreamble)`) ; sécurise contre l'écrasement de saisie utilisateur. **Choisir la sémantique v2** (moins agressive) — conserver le prompt utilisateur s'il a déjà écrit, mais réécrire model/effort/perm (qui sont des defaults techniques) |
| **Warning bypassPermissions** | `<p className="text-amber-300">` visible quand `perm === 'bypassPermissions'` | Bloc `.field-warn` (encart ambré, bordure gauche 2px, fond `rgba(232,176,74,0.06)`) avec puce `⚠` et texte `bypassPermissions :: agent will skip ALL permission prompts. Use only for trusted automated workspaces.` |
| **Defaults** | `bypassPermissions` par défaut (héritage du plan §3/§17) | À conserver — le défaut `bypassPermissions` reste pertinent (isolation par conteneur). Si une role est sélectionnée et a un `defaultPermissionMode`, il prime. Le warning sera donc visible au premier rendu pour la plupart des cas par défaut, ce qui est conforme au comportement actuel et **explicitement testé** (`renders the form when open=true with bypassPermissions default`). |
| **Erreur réseau** | `error` state + `<div className="text-red-400">` sous le formulaire | Conserver le même mécanisme, mais le rendre en `.field-warn` rouge (`color: var(--bad)` au lieu de `var(--warn)`) ou via une nouvelle classe `.field-error`. Plus simple : ajouter une petite déclinaison `.field-warn.error { color: var(--bad); border-color: var(--bad); }` ou inliner `style={{ color: 'var(--bad)' }}` |
| **Footer** | `Cancel` (gris) + `Create` (emerald-600) | `CANCEL` (`.btn.ghost`) + `CREATE TEAM →` (`.btn.primary` = fond amber) ; bouton désactivé via `disabled` + `opacity: canCreate ? 1 : 0.4` |
| **Disabled state du bouton** | `submitting OR !name OR !role OR !cwd OR !prompt` | Proto : `name.trim().length > 0 && prompt.trim().length > 0`. **À aligner sur l'existant** (qui inclut `!cwd`) car le backend exige `lead.cwd` non-vide. Donc `canCreate = !!name.trim() && !!cwd.trim() && !!prompt.trim()` et le role est garanti (au moins un role est pré-sélectionné via `roles[0]`). |
| **Champs absents du proto et qu'il faut conserver** | — | Aucun. Tous les champs proto sont déjà présents dans l'existant. |
| **Champs présents dans le proto et absents de l'existant** | — | Aucun — le proto n'ajoute pas de champ inédit, juste un nouveau layout. |

### 2.1 Ce qui ne change PAS

- **Signature du composant** : `{ open: boolean; onClose: () => void; onCreate: (body) => Promise<OrchestratorView> }` reste strictement identique. Le caller (`OrchestratorList.tsx:86-90`) ne touche à rien.
- **Forme du payload envoyé à `onCreate`** : reste celle attendue par `api.createOrchestrator`, soit `{ name, role?, roleId?, lead: { cwd, prompt?, preamble? }, defaults?: { model?, effort?, permissionMode? } }`. **Ne pas régresser** vers le format à plat du prototype (`{ name, role, cwd, prompt, preamble, model, effort, permissionMode }`) — le proto est en local, sans réel backend.
- **Source des roles** : `useRoles()` (poll 5s, déjà câblé) — pas de prop `roles` ajoutée au composant.
- **Source du `createRole`** : `useRoles().create` — déjà utilisé dans le flow "+ Create new role…" actuel.

---

## 3. Champs et validation

| Champ | Type | Required | Source default | Auto-fill depuis role | Sent comme |
|---|---|---|---|---|---|
| `name` | `string` (forcé UPPERCASE à submit) | **oui** (`trim().length > 0`) | `''` (auparavant `'smoke'`) | non | `body.name` |
| `roleId` | `string` (`<select>` value) | **oui** (au moins un role est toujours présélectionné via `roles[0]?.id`) | `roles[0]?.id` (premier role chargé) | n/a (c'est le sélecteur) | `body.roleId` (et `body.role = role.label`) |
| `cwd` | `string` | **oui** (`trim().length > 0`) | `'/swarm-fyrel/'` (parité proto) — peut-être remplacé par `''` puisqu'on ne sait pas si cette path existe sur l'instance cible ; **proposition : laisser `'/'` comme default** pour avoir un état valide au boot | non | `body.lead.cwd` |
| `prompt` | `string` (textarea) | **oui** (`trim().length > 0`) | `''` | `role.leadPrompt` (écrase si vide ou identique au précédent default — voir §3.1) | `body.lead.prompt` |
| `preamble` | `string` (textarea) | non | `''` | `role.leadPreamble` mais **seulement si `preamble` est encore vide** | `body.lead.preamble` (omis si vide) |
| `model` | `string` | non (default `claude-opus-4-7`) | `claude-opus-4-7` | `role.defaultModel` | `body.defaults.model` |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | non | `'xhigh'` (default actuel — conservé) | `role.defaultEffort` | `body.defaults.effort` |
| `perm` | `'auto' \| 'acceptEdits' \| 'bypassPermissions' \| 'default' \| 'dontAsk' \| 'plan'` | non | `'bypassPermissions'` (défaut historique du plan §3/§17) | `role.defaultPermissionMode` (cast) | `body.defaults.permissionMode` |

**Liste exacte des constantes** (à conserver depuis l'existant) :

```ts
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PERMS   = ['auto', 'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'] as const;
const MODELS  = [
  { value: 'claude-opus-4-7',             label: 'Opus 4.7 (claude-opus-4-7)' },
  { value: 'claude-sonnet-4-6',           label: 'Sonnet 4.6 (claude-sonnet-4-6)' },
  { value: 'claude-haiku-4-5-20251001',   label: 'Haiku 4.5 (claude-haiku-4-5-20251001)' },
] as const;
```

**Note** : le proto utilise `window.MODELS = ['claude-opus-4-7', 'claude-sonnet-4-7', 'claude-haiku-4-5']` et `EFFORTS = ['low','medium','high','xhigh']` (pas `'max'`). **Garder la liste de l'existant** (qui reflète les modèles réels supportés par le backend) ; le proto est une cible visuelle, pas une cible de données.

### 3.1 Sémantique du `useEffect` d'auto-fill

```ts
useEffect(() => {
  if (!selectedRole) return;
  // On réécrit systématiquement les defaults techniques (l'utilisateur les
  // ajustera après s'il veut). Pas de check "est-ce que c'est encore au
  // default" : trop fragile.
  if (selectedRole.defaultModel)        setModel(selectedRole.defaultModel);
  if (selectedRole.defaultEffort)       setEffort(selectedRole.defaultEffort);
  if (selectedRole.defaultPermissionMode)
    setPerm(selectedRole.defaultPermissionMode as (typeof PERMS)[number]);
  // En revanche on ne touche prompt/preamble que s'ils sont vides — c'est
  // ce que fait le proto pour le preamble (modals.jsx:20), on étend au
  // prompt par cohérence pour ne pas trasher la saisie de l'opérateur.
  setRole(selectedRole.label);
  if (!prompt.trim() && selectedRole.leadPrompt) setPrompt(selectedRole.leadPrompt);
  if (!preamble.trim() && selectedRole.leadPreamble) setPreamble(selectedRole.leadPreamble);
}, [selectedRole]);
```

### 3.2 `canCreate`

```ts
const canCreate =
  name.trim().length > 0 &&
  cwd.trim().length > 0 &&
  prompt.trim().length > 0 &&
  !submitting;
// roleId est garanti puisqu'on présélectionne roles[0] (sauf si le serveur
// renvoie 0 role, cas géré côté UI par un message "no roles available").
```

---

## 4. Composant complet (JSX final)

```tsx
import { useEffect, useMemo, useState } from 'react';
import type { OrchestratorView, RoleView } from '../api/client';
import { useRoles } from '../hooks/useRoles';
import { RoleDialog } from './RoleDialog';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (body: {
    name: string;
    role?: string;
    roleId?: string;
    lead: { cwd: string; prompt?: string; preamble?: string };
    defaults?: { model?: string; effort?: string; permissionMode?: string };
  }) => Promise<OrchestratorView>;
}

const CREATE_ROLE_SENTINEL = '__create_new__';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PERMS = ['auto', 'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'] as const;
const MODELS = [
  { value: 'claude-opus-4-7', label: 'opus-4-7' },
  { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
  { value: 'claude-haiku-4-5-20251001', label: 'haiku-4-5' },
] as const;

export function NewOrchestratorDialog({ open, onClose, onCreate }: Props) {
  const { roles, create: createRole } = useRoles();
  const [name, setName] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState<string>('');
  const [role, setRole] = useState('');
  const [cwd, setCwd] = useState('/');
  const [prompt, setPrompt] = useState('');
  const [preamble, setPreamble] = useState('');
  const [model, setModel] = useState<string>('claude-opus-4-7');
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('xhigh');
  const [perm, setPerm] = useState<(typeof PERMS)[number]>('bypassPermissions');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);

  // Présélection du premier role dès qu'on en a un (les rôles arrivent
  // après un tick, on ne peut pas se baser sur le state initial).
  useEffect(() => {
    if (!selectedRoleId && roles.length > 0) {
      setSelectedRoleId(roles[0].id);
    }
  }, [roles, selectedRoleId]);

  const selectedRole: RoleView | null = useMemo(
    () => (selectedRoleId ? roles.find((r) => r.id === selectedRoleId) ?? null : null),
    [selectedRoleId, roles],
  );

  // Auto-fill : réécrit toujours les defaults techniques, mais épargne
  // prompt / preamble si l'utilisateur a déjà tapé.
  useEffect(() => {
    if (!selectedRole) return;
    setRole(selectedRole.label);
    if (selectedRole.defaultModel) setModel(selectedRole.defaultModel);
    if (selectedRole.defaultEffort) setEffort(selectedRole.defaultEffort);
    if (selectedRole.defaultPermissionMode) {
      setPerm(selectedRole.defaultPermissionMode as (typeof PERMS)[number]);
    }
    if (!prompt.trim() && selectedRole.leadPrompt) setPrompt(selectedRole.leadPrompt);
    if (!preamble.trim() && selectedRole.leadPreamble) setPreamble(selectedRole.leadPreamble);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRole]);

  if (!open) return null;

  function onRolePicked(value: string) {
    if (value === CREATE_ROLE_SENTINEL) {
      setRoleDialogOpen(true);
      return;
    }
    setSelectedRoleId(value);
  }

  const canCreate =
    name.trim().length > 0 &&
    cwd.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !submitting;

  async function submit() {
    if (!canCreate) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim().toUpperCase(),
        role: role || undefined,
        ...(selectedRoleId ? { roleId: selectedRoleId } : {}),
        lead: {
          cwd: cwd.trim() || '/',
          prompt: prompt.trim(),
          ...(preamble.trim() ? { preamble: preamble.trim() } : {}),
        },
        defaults: { model, effort, permissionMode: perm },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            + NEW ORCHESTRATOR <span className="sub">// spin up a new team</span>
          </div>
          <button className="pr-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label htmlFor="orch-name">NAME</label>
              <input
                id="orch-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. NOMAD"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="orch-role">ROLE</label>
              <select
                id="orch-role"
                value={selectedRoleId}
                onChange={(e) => onRolePicked(e.target.value)}
              >
                {roles.length === 0 && <option value="">(no roles yet)</option>}
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
                <option value={CREATE_ROLE_SENTINEL}>+ create new role…</option>
              </select>
              {selectedRole && (
                <div className="field-help">
                  {selectedRole.workerCount != null && selectedRole.workerCount > 0 && (
                    <>will spawn {selectedRole.workerCount} worker
                    {selectedRole.workerCount > 1 ? 's' : ''}{' '}</>
                  )}
                  {selectedRole.connectors.find((c) => c.type === 'discord') && (
                    <>· discord webhook</>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="field">
            <label htmlFor="orch-cwd">WORKING DIRECTORY (CWD)</label>
            <input
              id="orch-cwd"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/workspace/path"
            />
            <div className="field-help">
              workspace-relative path the lead will operate from
            </div>
          </div>

          <div className="field">
            <label htmlFor="orch-prompt">LEAD PROMPT</label>
            <textarea
              id="orch-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='Initial task for the lead. e.g. "Ship the new swarm.bin under the new constraints."'
            />
          </div>

          <div className="field">
            <label htmlFor="orch-preamble">
              LEAD PREAMBLE <span style={{ color: 'var(--text-mute)' }}>// optional</span>
            </label>
            <textarea
              id="orch-preamble"
              value={preamble}
              onChange={(e) => setPreamble(e.target.value)}
              placeholder="System preamble injected before the lead prompt. Defaults from the role."
            />
          </div>

          <div className="field-3">
            <div className="field">
              <label htmlFor="orch-model">MODEL</label>
              <select
                id="orch-model"
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
              <label htmlFor="orch-perm">PERMISSION</label>
              <select
                id="orch-perm"
                value={perm}
                onChange={(e) => setPerm(e.target.value as (typeof PERMS)[number])}
              >
                {PERMS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>

          {perm === 'bypassPermissions' && (
            <div className="field-warn" role="alert">
              ⚠ bypassPermissions :: agent will skip ALL permission prompts.
              Safe inside the swarm-os container; do NOT use outside isolated
              environments.
            </div>
          )}

          {error && (
            <div
              className="field-warn"
              role="alert"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)', background: 'rgba(224,101,74,0.06)' }}
            >
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={submitting}>
            CANCEL
          </button>
          <button
            className="btn primary"
            disabled={!canCreate}
            onClick={() => void submit()}
            style={{ opacity: canCreate ? 1 : 0.4 }}
          >
            {submitting ? 'CREATING…' : 'CREATE TEAM →'}
          </button>
        </div>
      </div>

      <RoleDialog
        open={roleDialogOpen}
        onClose={() => setRoleDialogOpen(false)}
        onSubmit={async (body) => {
          const r = await createRole(body);
          setSelectedRoleId(r.id);
          return r;
        }}
      />
    </div>
  );
}
```

**Notes d'implémentation** :

- L'ancien helper `<Field>` interne et la constante `inputCls` (Tailwind) **disparaissent**. Les styles viennent de `.field input/textarea/select` du `desktop-theme.css`.
- Le `<RoleDialog>` est rendu **à l'intérieur** du `.modal-backdrop` (comme aujourd'hui). Son propre `.fixed inset-0` est plus haut en z-index (`z-40` Tailwind vs `z-index: 100` de `.modal-backdrop`) — **vérifier en QA visuelle** que le `RoleDialog` s'affiche bien par-dessus la modale parent. Si conflit : porter aussi `RoleDialog` au thème v2 (cf. Étape 10) ou ajouter `z-index: 110` inline temporaire.
- La `pr-close` est déjà stylée par `desktop-theme.css` (utilisée par les autres modals + `RightPanel`).

---

## 5. Flow "+ create new role" inline

### 5.1 Mécanisme

1. La dropdown ROLE inclut **trois groupes d'options** :
   - `(no roles yet)` (option vide rendue uniquement si `roles.length === 0`) ;
   - une `<option>` par role retourné par `useRoles()` ;
   - une option terminale `+ create new role…` avec `value={CREATE_ROLE_SENTINEL}` (`'__create_new__'`).
2. `onChange` du `<select>` route via `onRolePicked(value)`. Si `value === CREATE_ROLE_SENTINEL`, on **n'écrit pas** `selectedRoleId` (la dropdown garde visuellement l'ancienne valeur sélectionnée), on se contente de `setRoleDialogOpen(true)`. La dropdown rebascule donc sur l'ancien role pendant que le `RoleDialog` est ouvert — comportement souhaité (cf. existant, §63-74).
3. `<RoleDialog>` est monté en permanence avec `open={roleDialogOpen}` ; il ne se rend (et n'a pas d'effets) que quand `open === true`. Son `onClose` ferme la sous-modale sans rien sélectionner ; son `onSubmit` est intercepté par `NewOrchestratorDialog` pour appeler `createRole(body)` (alias `useRoles().create` → `POST /roles` + `refresh()`), puis `setSelectedRoleId(r.id)` pour basculer immédiatement la dropdown sur la role fraîchement créée.
4. Comme `useRoles().create` fait `await refresh()` avant de renvoyer le `RoleView`, **le nouveau role est garanti d'être dans `roles[]`** au moment où l'on `setSelectedRoleId(r.id)`. Le `useEffect([selectedRole])` se déclenche ensuite et auto-remplit MODEL/EFFORT/PERMISSION (et PROMPT/PREAMBLE s'ils étaient encore vides).
5. `RoleDialog.onClose()` est appelé in-fine par `RoleDialog` lui-même (il appelle `onClose()` après un `onSubmit` réussi, cf. `RoleDialog.tsx:118`).

### 5.2 Ordre de superposition (z-index)

| Surface | `z-index` (théorique avec `desktop-theme.css`) |
|---|---|
| `App` shell | 0 |
| `.panel-right` open | ~10 |
| `.modal-backdrop` (NewOrchestratorDialog v2) | 100 |
| `.modal.wide` (contenu) | 101 (auto, fils du backdrop) |
| `RoleDialog` (`.fixed inset-0 bg-black/60 z-40` — Tailwind, **non porté à ce stade**) | 40 — **inférieur !** |

⚠ **Point d'attention** : tel quel, `RoleDialog` (`z-40` Tailwind ≈ `z-index: 40`) sera *sous* `.modal-backdrop` (`z-index: 100`). Trois solutions :

- **(A)** Inliner `style={{ zIndex: 110 }}` sur le `RoleDialog` (override Tailwind, propre tant que `RoleDialog` n'est pas porté).
- **(B)** Rendre `RoleDialog` **hors** du `.modal-backdrop` (au même niveau, ou via React Portal) — plus propre mais demande de remonter `roleDialogOpen` au caller. Pas recommandé en C.9, à faire plus tard.
- **(C)** Porter `RoleDialog` au thème v2 dans la foulée (Étape 10). Le scope C.9 le permet si on accepte un léger débordement de périmètre.

**Choix recommandé pour C.9** : option (A), monter le `RoleDialog` avec `style={{ zIndex: 110 }}` (ou ajouter une prop optionnelle `zIndex?` à `RoleDialog` pour ne pas le contaminer ailleurs). Documenter dans le code que la suppression de ce style devient une issue de l'Étape 10.

### 5.3 Cas limites

- **Création de role qui échoue** : `RoleDialog` montre déjà son propre `error` interne (`{error && <div className="text-red-400">…</div>}`). Il ne ferme pas la modale → `NewOrchestratorDialog` n'a rien à faire.
- **Fermeture du `RoleDialog` sans création** : on n'a pas touché à `selectedRoleId` (cf. §5.1 point 2). La dropdown reste sur l'ancien role.
- **Backdrop click pendant que `RoleDialog` est ouvert** : le clic sur `.modal-backdrop` ferme la modale parente, ce qui démonte aussi le `RoleDialog`. Pour l'empêcher (UX moins surprenante), on peut conditionner le `onClick={onClose}` du backdrop : `onClick={(e) => { if (!roleDialogOpen) onClose(); }}` — décision laissée à l'implémenteur, faible enjeu.

---

## 6. Warning `bypassPermissions`

### 6.1 Quand est-il visible ?

- À tout moment où `perm === 'bypassPermissions'` :
  - **Au premier rendu** : le default initial du state est `'bypassPermissions'` (héritage v1). Le warning est donc visible **par défaut** dès l'ouverture de la modale — c'est intentionnel et **testé** par `it('renders the form when open=true with bypassPermissions default')`.
  - Quand l'opérateur choisit explicitement `bypassPermissions` dans le `<select>`.
  - Quand un role auto-applique `defaultPermissionMode = 'bypassPermissions'` (ex. `role.tools` dans le proto `data.jsx:109`).
- Masqué dès qu'une autre valeur est sélectionnée (`'default'`, `'acceptEdits'`, `'plan'`, etc.).

### 6.2 Style — ambre, pas rouge

Le proto utilise `.field-warn` :

```css
.field-warn {
  color: var(--warn);                       /* ≈ #e8b04a (amber) */
  border-left: 2px solid var(--warn);
  padding: 6px 10px; margin-top: 4px;
  background: rgba(232, 176, 74, 0.06);
  font-family: "Geist Mono", monospace; font-size: 10px;
  letter-spacing: 0.10em;
}
```

C'est un **warning ambré** (pas un erreur rouge). Le choix est volontaire :
`bypassPermissions` n'est pas un erreur, c'est un mode dangereux mais
légitime dans le conteneur swarm-os (cf. plan §3 et §17). Le rouge
(`var(--bad)`, `#e0654a`) est réservé aux erreurs (réseau, validation
serveur).

### 6.3 Texte

Adopter une formulation hybride entre le proto et l'existant :

> `⚠ bypassPermissions :: agent will skip ALL permission prompts. Safe
> inside the swarm-os container; do NOT use outside isolated environments.`

Cette formulation :
- garde le préfixe `⚠ bypassPermissions ::` du proto pour la cohérence visuelle Geist Mono ;
- garde l'avertissement explicite "Safe inside the swarm-os container; do NOT use outside" de l'existant (pédagogiquement utile car ces lignes sont déjà documentées dans le plan) ;
- reste détectable par le test existant (regex `/bypassPermissions disables/i` à mettre à jour vers `/bypassPermissions/i` ou `/skip ALL permission prompts/i` — cf. §7).

### 6.4 Accessibilité

- Ajouter `role="alert"` sur le `.field-warn` pour qu'un screen reader le détecte au changement de `perm` (live region implicite avec `role=alert`).
- Pas de focus trap nécessaire — la modale parent est déjà focus-trappée (à vérifier ; sinon, hors scope de C.9).

---

## 7. Adaptation des tests

`packages/web/src/components/NewOrchestratorDialog.test.tsx` — 5 tests, tous doivent rester verts. Modifications minimales :

| Test | Sélecteur actuel | Nouveau sélecteur (post-port) | Raison |
|---|---|---|---|
| `does not render when open=false` | `expect(container.firstChild).toBeNull()` | **inchangé** | Le composant retourne toujours `null` quand `!open`. |
| `renders the form when open=true with bypassPermissions default` | `screen.getByText('New orchestrator')` puis `screen.getByText(/bypassPermissions disables/i)` | `screen.getByText(/NEW ORCHESTRATOR/i)` puis `screen.getByText(/bypassPermissions/i)` (ou `screen.getByRole('alert')`) | Titre passe à `+ NEW ORCHESTRATOR`. Texte du warning change : on cible `bypassPermissions` qui reste, ou on cible le `role="alert"`. |
| `disables the Create button when cwd is empty` | `screen.getByRole('button', { name: /Create/i })` | `screen.getByRole('button', { name: /CREATE TEAM/i })` (ou `/CREATE/i` qui matche encore) | Libellé passe à `CREATE TEAM →`. ⚠ Penser à mettre à jour aussi le default du `cwd` dans le composant : si on garde le default `'/'` (non vide), **ce test va casser** car le bouton ne sera plus disabled au boot. Deux options : (a) changer le default à `''` dans le composant (rupture avec le proto qui a `'/swarm-fyrel/'`), (b) adapter le test pour vider explicitement le champ cwd avant d'asserter. **Option (b)** recommandée : `fireEvent.change(cwdInput, { target: { value: '' } })`. Le test devient `disables the Create button when cwd is cleared`. |
| `enables Create when all required fields are filled` | `screen.getByPlaceholderText('/mon-projet')` puis `screen.getByRole('button', { name: /Create/i })` | `screen.getByPlaceholderText('/workspace/path')` (nouveau placeholder) puis `screen.getByRole('button', { name: /CREATE TEAM/i })` | Placeholder cwd change. ⚠ De plus, l'ancien default `name='smoke'` disparaît (on passe à `''`). Le test doit donc aussi remplir `name` : `const nameInput = screen.getByPlaceholderText(/e\.g\. NOMAD/i); fireEvent.change(nameInput, { target: { value: 'smoke' } })`. Idem pour `prompt` (default actuel `'say hi'` → nouveau default `''`). |
| `calls onCreate with the form values when Create is clicked` | `screen.getByPlaceholderText('/mon-projet')` + click `/Create/i` + `expect(call.name).toBe('smoke')` | Idem que précédent ; en plus `expect(call.name).toBe('SMOKE')` car `submit()` applique `.toUpperCase()` (parité proto). Sinon désactiver l'uppercase et garder `'smoke'`. **Recommandation** : garder l'uppercase (parité visuelle avec les team-pills toutes en majuscules) + ajuster le test. |

### 7.1 Patch type proposé

```diff
- expect(screen.getByText('New orchestrator')).toBeInTheDocument();
- expect(screen.getByText(/bypassPermissions disables/i)).toBeInTheDocument();
+ expect(screen.getByText(/NEW ORCHESTRATOR/i)).toBeInTheDocument();
+ expect(screen.getByRole('alert')).toHaveTextContent(/bypassPermissions/i);

- const cwdInput = screen.getByPlaceholderText('/mon-projet');
+ const cwdInput = screen.getByPlaceholderText('/workspace/path');
+ const nameInput = screen.getByPlaceholderText(/e\.g\. NOMAD/i);
+ const promptInput = screen.getByPlaceholderText(/Ship the new swarm\.bin/i);
+ fireEvent.change(nameInput, { target: { value: 'smoke' } });
+ fireEvent.change(promptInput, { target: { value: 'say hi' } });
  fireEvent.change(cwdInput, { target: { value: '/workspace/x' } });

- const createBtn = screen.getByRole('button', { name: /Create/i });
+ const createBtn = screen.getByRole('button', { name: /CREATE TEAM/i });

- expect(call.name).toBe('smoke');
+ expect(call.name).toBe('SMOKE');
```

Pour le test "disables the Create button when cwd is empty" :

```diff
- // ancien comportement : cwd default vide, donc déjà disabled.
+ // nouveau comportement : il faut vider cwd explicitement.
+ const cwdInput = screen.getByPlaceholderText('/workspace/path');
+ fireEvent.change(cwdInput, { target: { value: '' } });
  const createBtn = screen.getByRole('button', { name: /CREATE TEAM/i });
  expect(createBtn).toBeDisabled();
```

Si le test "renders the form when open=true with bypassPermissions default" doit aussi vérifier que le warning *change* en switchant la permission, ajouter un sous-test :

```ts
it('hides the warning when permission is changed away from bypassPermissions', () => {
  render(<NewOrchestratorDialog open={true} onClose={() => undefined} onCreate={makeOnCreate()} />);
  const permSelect = screen.getByLabelText(/permission/i);
  fireEvent.change(permSelect, { target: { value: 'default' } });
  expect(screen.queryByRole('alert')).toBeNull();
});
```

(Optionnel, c'est un bonus de couverture.)

### 7.2 Tests qui n'existent pas encore (suggestion bonus)

- "select '+ create new role…' opens RoleDialog" (vérifier que `getByText(/New role/i)` apparaît après `fireEvent.change(roleSelect, { target: { value: '__create_new__' } })`).
- "auto-fills model/effort/perm when a role is selected" — nécessite de mocker `useRoles` pour fournir un role avec des defaults connus.

Non bloquants pour C.9, à classer comme follow-up.

---

## 8. Plan d'implémentation pas-à-pas

1. **Pré-requis Étape 1** : vérifier que `packages/web/src/styles/desktop-theme.css` est bien importé depuis `main.tsx` et expose les classes `.modal-backdrop`, `.modal`, `.modal.wide`, `.modal-head`, `.modal-body`, `.modal-foot`, `.modal-title`, `.modal-title .sub`, `.pr-close`, `.field`, `.field-row`, `.field-3`, `.field-help`, `.field-warn`, `.seg-radio`, `.seg-radio button.on`, `.btn`, `.btn.primary`, `.btn.ghost`. **Sinon, blocage** : ces classes doivent exister avant Étape 9. Si elles manquent encore, extraire depuis `prototypes/swarm-os-prototypes_v2.zip` (section CSS du HTML) et les ajouter à `desktop-theme.css` (voir §1 du présent doc pour le CSS complet).
2. **Backup** : `git mv packages/web/src/components/NewOrchestratorDialog.tsx packages/web/src/components/NewOrchestratorDialog.legacy.tsx` n'est **PAS** souhaité — réécrire en place pour préserver les imports.
3. **Réécriture du composant** : remplacer intégralement le contenu de `packages/web/src/components/NewOrchestratorDialog.tsx` par le code fourni en §4. Conserver la même signature de props (`Props`), le même nom d'export (`NewOrchestratorDialog`).
4. **Suppression des résidus Tailwind** : supprimer les locales `inputCls`, `Field` helper interne.
5. **Constantes MODELS** : remplacer le formatage `label: 'Opus 4.7 (claude-opus-4-7)'` par le format court Geist `label: 'opus-4-7'` (cohérence visuelle proto). Décision : garder le format long si l'opérateur doit voir précisément la version (préférence à valider, mais le proto est plus minimaliste).
6. **`RoleDialog` z-index** : ajouter un `style={{ zIndex: 110 }}` sur le `<div className="fixed inset-0">` interne de `RoleDialog`, OU passer un wrapper via `style`. Variante moins invasive : ajouter un prop optionnel `containerStyle?: CSSProperties` à `RoleDialog`, l'appliquer à son wrapper. À choisir avec l'auteur initial du composant.
7. **Tests** : appliquer les patches du §7. Lancer `pnpm --filter @swarm-os/web test` (ou commande équivalente) — tout doit passer.
8. **QA visuelle** (`docker build -t swarm-os:latest .` + `docker compose -f docker-compose.test.yml up -d`) :
   - Cliquer "+ NEW TEAM" depuis `OrchestratorList` (ou le futur `TopBar`).
   - Vérifier le rendu warm-black, le titre `+ NEW ORCHESTRATOR // spin up a new team`, l'amber des boutons, le `seg-radio` EFFORT.
   - Sélectionner "+ create new role…" → `RoleDialog` s'ouvre au-dessus.
   - Créer un role → le `<select>` rebascule dessus.
   - Switcher permission → vérifier que le warning ambré apparaît/disparaît.
   - Submit OK → modale se ferme, nouvelle team apparaît dans la liste.
   - Submit en erreur (ex. backend down) → bloc `.field-warn` rouge avec le message.
9. **Documentation** : aucun changement à `docs/ui-redesign-desktop.md` (déjà à jour, §3.5 et §5.1 step 9 référencent ce port).

---

## 9. Tests de fumée

À jouer **manuellement** dans l'app dockerisée après build :

1. **Rendu initial** : "+ NEW TEAM" → modale apparaît, NAME a le focus, `CREATE TEAM →` est disabled (cwd vide ou name vide).
2. **Default `bypassPermissions`** : le bloc ambré `⚠ bypassPermissions ::` est visible dès l'ouverture.
3. **Toggle permission** : changer pour `default` → warning disparaît ; revenir → warning réapparaît.
4. **Toggle EFFORT** : cliquer chaque bouton du `.seg-radio` → un seul a la classe `.on` à la fois, fond `rgba(255,176,96,0.12)`, texte amber.
5. **Auto-fill role** : sélectionner un role custom existant → MODEL/EFFORT/PERMISSION se mettent à jour ; LEAD PROMPT/PREAMBLE se remplissent si vides, restent intacts si non-vides.
6. **"+ create new role"** : sélectionner l'option → `RoleDialog` s'ouvre par-dessus (z-index OK). Saisir `label = "test-role"`, défaut model `claude-haiku-4-5-20251001`, créer → `RoleDialog` se ferme, dropdown affiche maintenant `test-role` comme sélection courante, et les defaults de la role sont appliqués.
7. **Submit valide** : NAME="nomad", CWD="/", PROMPT="say hi", role par défaut, MODEL=opus-4-7, EFFORT=xhigh, PERM=bypassPermissions → cliquer `CREATE TEAM →` → bouton passe à `CREATING…` puis modale se ferme.
8. **Vérif backend** : `curl -H "X-Auth-Token: $TOKEN" http://localhost:8080/orchestrators` renvoie un orchestrator avec `name: "NOMAD"` (UPPERCASE), `role: "<label de la role>"`, `defaultModel: "claude-opus-4-7"`, `defaultPermissionMode: "bypassPermissions"`, `sessions[0].cwd: "/"`.
9. **Submit invalide** (ex. backend stoppé) : l'erreur réseau apparaît en rouge dans la modale, la modale reste ouverte, le bouton revient à `CREATE TEAM →` (non-`CREATING…`).
10. **Fermeture** : clic backdrop, clic `×`, clic `CANCEL`, et touche `Escape` (à vérifier — historiquement non géré, hors scope si absent) → tous ferment la modale et appellent `onClose`.
11. **Réouverture** : après `onClose`, rouvrir la modale → le state est **réinitialisé** au boot du composant (les `useState(...)` réinitialisent car le composant est démonté quand `!open` retourne `null`). Vérifier que `name`, `cwd`, `prompt`, `preamble`, `selectedRoleId` reviennent à leurs valeurs initiales.
12. **Tests Vitest** : `pnpm --filter @swarm-os/web test NewOrchestratorDialog` doit afficher 5/5 (ou plus si tests bonus ajoutés).

---

## 10. Risques & points d'attention

- **z-index `RoleDialog`** (cf. §5.2) — risque visuel principal. Mitigé par `style={{ zIndex: 110 }}` temporaire.
- **Réécriture du `useEffect` d'auto-fill** : le proto écrase seulement le preamble s'il est vide. L'existant écrase tout. Le compromis proposé (§3.1) — toujours écraser MODEL/EFFORT/PERM, ne pas écraser PROMPT/PREAMBLE non-vides — est **un changement de comportement** par rapport à l'existant. À valider avec l'opérateur si une UX strictement identique à l'existant est requise (auquel cas conserver le `if (selectedRole.leadPrompt) setPrompt(selectedRole.leadPrompt)` inconditionnel, à l'instar de l'existant).
- **`name.toUpperCase()` à submit** : non-rétrocompatible avec les tests actuels (`call.name === 'smoke'`). Choix à acter ; recommandation : garder l'uppercase pour cohérence visuelle (team-pills toutes en majuscules dans le proto), ajuster le test.
- **`cwd` default** : le proto a `'/swarm-fyrel/'` qui n'a aucun sens chez le user final. Le mettre à `'/'` (état valide minimal) est un bon compromis. À ne PAS laisser à `''` sinon le bouton est disabled par défaut (UX dégradée).
- **Cohabitation Tailwind/CSS-custom** : la classe `.btn`, `.field` etc. n'utilise pas le préfixe Tailwind. Vérifier qu'aucune purge Tailwind ne les supprime (cf. risque §5.4 du doc parent). L'Étape 1 (`desktop-theme.css`) doit avoir validé ce point.
- **Pré-requis Étape 1** : ce port présuppose que `desktop-theme.css` existe et expose les classes listées au §8.1. Si non, étape de blocage à régler avant.
- **Le warning rouge pour les erreurs** : on réutilise `.field-warn` avec un override inline. Si plusieurs composants ont besoin d'une variante `.field-warn.error` (rouge), ajouter une règle CSS dédiée dans `desktop-theme.css` plutôt que d'inliner partout. À discuter avec l'Étape 1.

---

## 11. Récap des fichiers touchés

| Fichier | Action |
|---|---|
| `packages/web/src/components/NewOrchestratorDialog.tsx` | **Réécriture intégrale** (signature de props conservée) |
| `packages/web/src/components/NewOrchestratorDialog.test.tsx` | Patch des sélecteurs + ajout de remplissage des défauts (cf. §7) |
| `packages/web/src/components/RoleDialog.tsx` | **Éventuel** : ajout d'un prop `containerStyle?: CSSProperties` ou inline `style={{ zIndex: 110 }}` sur son wrapper (cf. §5.2) |
| `packages/web/src/styles/desktop-theme.css` | **Aucune modification si Étape 1 est complète**. Sinon, ajouter les classes manquantes (`.modal-*`, `.field*`, `.seg-radio`, `.btn*`, `.pr-close`). |
| `packages/web/src/components/OrchestratorList.tsx` | **Aucun changement** (props identiques) |
| `packages/web/src/hooks/useRoles.ts`, `useOrchestrators.ts` | **Aucun changement** |
| `packages/web/src/api/client.ts` | **Aucun changement** (`createOrchestrator` et `createRole` déjà exposés) |

---

## 12. Ce que cette étape NE fait PAS

- Pas de changement backend (POST `/orchestrators` et `/roles` sont déjà là).
- Pas de port de `RoleDialog` au thème v2 (réservé à Étape 10).
- Pas de migration du caller `OrchestratorList.tsx` vers le `DesktopShell`/`TopBar` v2 (réservé aux Étapes 4 et 5).
- Pas de gestion du raccourci clavier `ESC` pour fermer (à reporter dans un follow-up "modal accessibility" global).
- Pas de focus trap (idem).
- Pas de validation côté client autre que `trim().length > 0` (les contraintes serveur — unicité du nom, format du cwd — restent côté backend, rapportées via `error`).
