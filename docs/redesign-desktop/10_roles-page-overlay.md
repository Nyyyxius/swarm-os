# Étape 10 (Phase C.10) — Migration de `RolesPage` vers l'overlay v2 plein écran

> **Périmètre exact** : remplacer la `RolesPage` actuelle (Tailwind `space-y-2`,
> ouverte dans un `<main>` plein-écran sous le header v1) par l'overlay v2
> du prototype (`prototypes/v2/modals.jsx:119-218`), à savoir une surface
> `position: fixed` qui démarre **sous** la TopBar (56 px), avec
> `grid-template-columns: 320px 1fr` : aside `roles-side` (liste cliquable
> + bouton `+ NEW ROLE`) à gauche, `roles-main` (détail du role
> sélectionné, sections inline EDIT) à droite. La logique CRUD reste
> identique (`GET /roles`, `POST /roles`, `PATCH /roles/:id`,
> `DELETE /roles/:id`). `RoleDialog` est **fusionné dans les sections
> EDIT inline** — pour cette étape, il n'est conservé que pour le flux
> "+ create new role…" déclenché depuis `NewOrchestratorDialog` (Étape 9).
> L'overlay s'ouvre depuis le bouton ROLES de la TopBar (Étape 4) ET
> depuis la route `#/roles` (parité avec l'existant).

---

## 1. Objectif

Aligner la gestion des rôles sur la charte v2 : un overlay fullscreen
opaque (le contenu sous-jacent est masqué, l'utilisateur sort de la
"map view"), avec une liste verticale de templates à gauche et un détail
sectionné à droite (DEFAULTS · LEAD PROMPT · LEAD PREAMBLE · WORKER
PREAMBLE · CONNECTORS). Chaque section a son propre bouton `EDIT` qui
bascule la section en mode édition inline (champ + boutons SAVE/CANCEL),
ce qui rend la modale `RoleDialog` redondante pour ce chemin. La
sémantique CRUD ne bouge pas — c'est de l'UX et du thème.

---

## 2. Diff fonctionnel

### 2.1 Page actuelle vs overlay v2

| Aspect | Existant (`RolesPage.tsx`) | v2 cible |
|---|---|---|
| **Conteneur** | `<div>` Tailwind, rendu dans `<main className="flex-1 p-4">` de `App.tsx` (donc sous le header v1) | `<div className="roles-overlay">` `position: fixed; inset: 56px 0 0 0; z-index: 60` ; overlay opaque qui masque la MapView/LeftPanel/RightPanel sous-jacents (la TopBar reste visible — affordance "where am I") |
| **Layout** | Liste verticale unique de cartes (`<ul className="space-y-2">`), un bouton `Edit` par carte qui ouvre `RoleDialog` | `grid-template-columns: 320px 1fr` — aside `roles-side` (liste compacte cliquable) + `roles-main` (détail + 5 sections EDIT inline) |
| **Sélection** | Implicite (aucun état "selected") — chaque carte est un item plat | Explicite : `selectedRoleId` state local ; carte cliquée passe en `.active` (bordure gauche ambrée + fond `rgba(255,176,96,0.08)`) ; `roles-main` affiche le détail du role sélectionné |
| **Ouverture du détail** | Clic "Edit" → `RoleDialog` modal en surimpression | Clic sur item de liste → détail s'affiche immédiatement dans `roles-main` (pas de modale supplémentaire) |
| **Édition** | Champs dans `RoleDialog` (modal séparée, formulaire complet) | **Sections inline** : chaque section affiche par défaut un rendu read-only (`.cfg-kv` ou `.cfg-pre`) + bouton `EDIT` ; clic EDIT → la section devient un mini-form (input/textarea + bouton SAVE/CANCEL) ; clic SAVE → `PATCH /roles/:id` partiel ; clic CANCEL → restaure |
| **Création** | Bouton "New role" en haut → `RoleDialog` (vide) | Bouton `+ NEW ROLE` dans `roles-add` (bas de la sidebar) — comportement à acter : (A) inline (crée un role-stub vierge `{ label: 'untitled', ... }`, l'auto-sélectionne, l'utilisateur édite chaque section), (B) prompt léger pour le `label` requis, puis stub. **Recommandation** : (B), car `label` est non-nullable côté backend |
| **Header** | "Roles" `<h2>` + paragraphe d'aide + bouton Refresh | `roles-side-head` : `← BACK TO MAP` (équivalent `onClose`), titre `ROLES`, sub `templates for spawning new teams` ; bouton Refresh **disparaît** (poll 5 s déjà câblé par `useRoles`) — ou reste optionnel via raccourci clavier |
| **Fermeture** | Aucune (la page est une route à part entière, on en sort en cliquant "Orchestrators" dans le header) | Bouton `← BACK TO MAP` qui appelle `onClose()` ; le caller (DesktopShell, route `#/roles`) bascule la route vers `#/` et démonte l'overlay |
| **État vide** | `<div>No roles yet — click "New role"…</div>` | Sidebar vide ; `roles-main` montre un `field-help` "No role selected" ; un seul bouton `+ NEW ROLE` cliquable |
| **Chargement / erreur** | `loading…` / `Error: <msg>` | Identique mais stylé `.field-help` (grise) ou `.field-warn` (ambre/rouge) à la place des classes Tailwind |
| **Delete** | Bouton "Delete" sur chaque carte (`confirm(...)` natif) | Bouton `DELETE` dans `roles-main` (`.btn.danger`, sous les sections, à côté de `DUPLICATE`) ; **confirmation** : utiliser `ConfirmModal` (cf. `v2/panels.jsx`) plutôt que `confirm()` natif — cohérence avec le reste de l'app v2 |
| **Duplicate** | Absent | Bouton `DUPLICATE` (`.btn`) qui pré-remplit un nouveau role-stub avec les champs du role courant (label = `<label> (copy)`) et l'auto-sélectionne après `POST /roles` |
| **Affichage des tags** | Pastilles ambre/slate Tailwind (`bg-slate-800`, `bg-indigo-900/60`) | `.tag-pill` Geist Mono 8.5 px (`{N} WRK`, `{model}`, `E:{effort}`, `DISCORD` en `.tag-pill.discord` ambre, `LEAD-PROMPT`) |
| **Connecteurs Discord** | Champ URL dans `RoleDialog` ; affichage par pastille `Discord` sur la carte | Section dédiée `CONNECTORS` dans `roles-main` qui affiche l'URL en `.cfg-kv` ; mode EDIT permet add/edit/delete (cf. §5) |

### 2.2 Ce qui ne change PAS

- **Hook `useRoles()`** : signature identique (`{ roles, loading, error, refresh, create, update, destroy }`). L'overlay le consomme tel quel.
- **Forme du payload `update`** : `Partial<RoleInput>` — le backend accepte les patches partiels, donc chaque section peut envoyer son sous-set (`PATCH /roles/:id { leadPrompt: '...' }` par exemple).
- **Forme du payload `create`** : `Partial<RoleInput> & { label: string }` — `label` reste seul required.
- **Types `RoleView`, `RoleInput`, `ConnectorView`, `DiscordConnectorView`** : aucun changement nécessaire dans `api/client.ts`.
- **Route `#/roles`** : conservée comme deeplink ; `App.tsx` (puis `DesktopShell.tsx` à terme) garde le `setRoute({ kind: 'roles' })` qui monte l'overlay.

### 2.3 Sections inline EDIT vs RoleDialog

| Critère | `RoleDialog` (modale unique) | Sections inline (v2) |
|---|---|---|
| **Surface** | 1 modale `.fixed z-40` contenant tous les champs | 5 sections en colonne dans `roles-main`, scroll naturel |
| **Granularité du save** | 1 seul submit → 1 `PATCH` global (avec tous les champs, même inchangés) | 1 `PATCH` par section sauvée — payload minimal (`{ leadPrompt }`, `{ defaults: {...} }`, etc.) |
| **Dirty state** | 1 booléen `submitting` global | 1 booléen `editing[section]` + 1 snapshot par section pour rollback CANCEL |
| **Discoverability** | "Edit" sur la carte → tout le formulaire | "EDIT" par section → focus immédiat sur le champ concerné, le reste reste read-only |
| **Risque de perte de saisie** | Si l'utilisateur ferme accidentellement la modale, tout est perdu | Une seule section ouverte à la fois (recommandé) ; CANCEL restaure ; les autres sections sont inertes |
| **Validation** | Centralisée à la fin (avant `PATCH`) | Par section, au moment du SAVE — validation locale (ex. URL Discord en `https://`) |

**Décision retenue** : remplacer `RoleDialog` **pour ce chemin** par les sections inline. Conserver `RoleDialog` **uniquement** pour le flux "+ create new role…" déclenché depuis `NewOrchestratorDialog` (Étape 9), en attendant un refactor ultérieur qui extrairait un composant `RoleForm` partagé (cf. §7).

---

## 3. Architecture

### 3.1 Composant unique ou liste+détail ?

**Composant unique** `RolesOverlay` (renommage de `RolesPage`). Le split
sidebar/main est interne : pas besoin de composants séparés tant que la
logique reste simple. Si la croissance le justifie (édition multi-section
simultanée, sous-formulaires partagés), on extraira `RoleSidebar.tsx` et
`RoleDetail.tsx` plus tard. Pour C.10, **un seul fichier**
`packages/web/src/components/RolesPage.tsx` réécrit.

**Sous-composants internes** (functions dans le même fichier, non
exportées) :

- `RoleItem` — ligne de la liste à gauche (nom + id + tags) ;
- `Section` — wrapper générique `{ title, editing, onEdit, onSave, onCancel, dirty, children }` qui gère l'affichage du bouton EDIT/SAVE/CANCEL et l'état "dirty" ;
- `DefaultsSection`, `LeadPromptSection`, `LeadPreambleSection`, `WorkerPreambleSection`, `ConnectorsSection` — une par section, encapsulant son state local + sa validation.

### 3.2 Gestion de `selectedRoleId`

```ts
const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

// Présélection : premier role disponible après chargement initial.
useEffect(() => {
  if (selectedRoleId == null && roles.length > 0) {
    setSelectedRoleId(roles[0].id);
  }
  // Si le role sélectionné a été supprimé entre deux refresh, retomber
  // sur le premier disponible (ou null si la liste est vide).
  if (selectedRoleId != null && !roles.find((r) => r.id === selectedRoleId)) {
    setSelectedRoleId(roles[0]?.id ?? null);
  }
}, [roles, selectedRoleId]);

const role = useMemo(
  () => roles.find((r) => r.id === selectedRoleId) ?? null,
  [roles, selectedRoleId],
);
```

**Important** : `useRoles` poll toutes les 5 s. Si l'utilisateur est en
train d'éditer une section, le `role` derrière les champs peut
"sauter" sous le poll (refresh écrase les valeurs locales). Mitigation :

- Chaque section gère son **propre state local** initialisé depuis `role`
  via `useEffect([role?.id, editing])`. Tant que `editing === false`, le
  state local se met à jour avec les refresh (read-only). Dès qu'on
  passe en `editing === true`, le state local est **gelé** vis-à-vis des
  refresh (on continue à recevoir les `roles` mis à jour, mais on
  n'écrase pas les buffers d'édition).

### 3.3 Dirty state

Le dirty state est **local à chaque section** :

```ts
function useDraft<T>(initial: T, editing: boolean) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    if (!editing) setDraft(initial);
    // Quand on passe en mode édition, on capture initial une seule fois.
    // Quand on quitte (SAVE ou CANCEL), le caller doit remettre editing=false ;
    // l'effet suivant ré-initialisera depuis le nouvel `initial`.
  }, [initial, editing]);
  const dirty = !shallowEqual(draft, initial);
  return { draft, setDraft, dirty };
}
```

(Le `shallowEqual` peut être remplacé par une comparaison naïve `===`
pour les types primitifs — `string`, `number`, `null` — qui couvrent la
plupart des champs ; pour `connectors` et `defaults` on compare par
sérialisation JSON ou champ par champ.)

**Garde-fou global** : un `unsavedDraftCount` (somme des `dirty` par
section) permet d'afficher un warning si l'utilisateur tente de
basculer vers un autre role ou de fermer l'overlay :

```ts
function onSelectRole(id: string) {
  if (unsavedDraftCount > 0 && !confirm('Discard unsaved changes?')) return;
  setSelectedRoleId(id);
}
function onClose() {
  if (unsavedDraftCount > 0 && !confirm('Discard unsaved changes?')) return;
  parentOnClose();
}
```

(À terme remplacer `confirm` natif par un `ConfirmModal` cohérent —
hors scope C.10 strict, à classer follow-up.)

### 3.4 Edition concurrente

**Une seule section éditable à la fois.** Quand l'utilisateur clique
EDIT sur une section pendant qu'une autre est déjà ouverte, on demande
confirmation (si dirty) puis on bascule. Implémentation : `editingSection`
est un `string | null` (ex. `'leadPrompt'`, `'connectors'`) au niveau
du composant `RolesPage`, pas un boolean par section.

---

## 4. Sections détaillées

### 4.1 DEFAULTS (`workerCount`, `defaultModel`, `defaultEffort`, `defaultPermissionMode`)

| Champ | Source | Type | Validation | Submit |
|---|---|---|---|---|
| `workerCount` | `role.workerCount` | `number \| null` (input `type="number"` min=0) | entier ≥ 0 ou vide (= `null`) | `PATCH /roles/:id { workerCount: <n>\|null }` |
| `defaultModel` | `role.defaultModel` | `string \| null` (`<select>` parmi `MODELS` + option vide = inherit) | aucun (le serveur valide la liste) | `{ defaultModel: <s>\|null }` |
| `defaultEffort` | `role.defaultEffort` | `'low'\|'medium'\|'high'\|'xhigh'\|'max' \| null` (`.seg-radio` + bouton "inherit") | enum | `{ defaultEffort: <s>\|null }` |
| `defaultPermissionMode` | `role.defaultPermissionMode` | `string \| null` (`<select>` parmi `PERMS` + option vide) | aucun | `{ defaultPermissionMode: <s>\|null }` |

**Rendu read-only** (par défaut) :

```tsx
<div className="cfg-kv">
  <span className="k">WORKER COUNT</span>
  <span className="v">{role.workerCount ?? '— (inherit)'}</span>
  <span className="k">MODEL</span>
  <span className="v">{role.defaultModel ?? '— (inherit)'}</span>
  <span className="k">EFFORT</span>
  <span className="v">{role.defaultEffort ?? '— (inherit)'}</span>
  <span className="k">PERMISSION</span>
  <span
    className="v"
    style={{
      color: role.defaultPermissionMode === 'bypassPermissions'
        ? 'var(--warn)' : 'var(--text)',
    }}
  >
    {role.defaultPermissionMode ?? '— (inherit)'}
  </span>
</div>
```

**Rendu EDIT** : 4 `.field` empilés (workerCount → model → effort → perm),
boutons SAVE/CANCEL à droite du header de section. SAVE désactivé si
draft invalide (workerCount non-entier ou < 0).

### 4.2 LEAD PROMPT (`role.leadPrompt`)

| Champ | Type | Validation | Submit |
|---|---|---|---|
| `leadPrompt` | `string \| null` (textarea multilignes) | aucun (vide → `null`, sinon string) | `PATCH /roles/:id { leadPrompt: <s>\|null }` |

**Rendu read-only** :

```tsx
<div className="cfg-pre">{role.leadPrompt || '— (none) —'}</div>
```

**Rendu EDIT** : `<textarea>` (min-height ~120 px, font Geist Mono),
SAVE/CANCEL.

### 4.3 LEAD PREAMBLE (`role.leadPreamble`)

Identique à LEAD PROMPT (même type, même validation, même rendu),
ciblant `leadPreamble`. Comme indiqué dans le proto, le placeholder du
mode EDIT peut être : "System preamble injected before the lead prompt.
Inherited by spawned teams unless they override at creation time."

### 4.4 WORKER PREAMBLE (`role.workerPreamble`)

Identique à LEAD PROMPT, ciblant `workerPreamble`. Placeholder mode EDIT :
"System preamble for workers spawned in teams using this role.
Workers inherit this unless overridden by `team.spawn_worker(preamble=…)`."

### 4.5 CONNECTORS

**Une seule sous-section** pour la v1 : `DISCORD` (un seul webhook).
Le contrat `RoleView.connectors` est un tableau (`ConnectorView[]`)
mais aujourd'hui contient au plus un `DiscordConnectorView`. L'UI
reflète ce constat : un seul slot DISCORD, modifiable, supprimable. Si
plus tard d'autres connecteurs apparaissent (Slack, PagerDuty…), on
ajoutera des sous-sections.

| Sous-section | Champ | Type | Validation | Submit |
|---|---|---|---|---|
| DISCORD | `webhookUrl` | `string` | URL commençant par `https://` ; pour plus de rigueur : matche `https?://(canary\.)?discord(app)?\.com/api/webhooks/\d+/[\w-]+` (souple — un simple `^https?://` est acceptable v1) | `PATCH /roles/:id { connectors: [{ type:'discord', webhookUrl: '<url>' }] }` ou `{ connectors: [] }` pour delete |

**Rendu read-only** :

```tsx
{discord ? (
  <div className="cfg-kv">
    <span className="k">DISCORD</span>
    <span
      className="v"
      style={{ fontSize: 10.5, color: 'var(--text-dim)', wordBreak: 'break-all' }}
    >
      {discord.webhookUrl}
    </span>
  </div>
) : (
  <div className="field-help">
    No Discord webhook. Configure to relay session-waiting events to a channel.
  </div>
)}
```

**Rendu EDIT** : un seul `.field` `<input type="url">` + boutons
SAVE/CANCEL. Si `webhookUrl` est vide à la sauvegarde et qu'un
connecteur existait, on envoie `{ connectors: [] }` (delete). Si on
remplit alors qu'il était absent : `{ connectors: [{ type:'discord', webhookUrl }] }`
(add).

Voir §5 pour le détail UI add/edit/delete.

---

## 5. Connecteurs Discord — UI add/edit/delete

### 5.1 Trois états visuels

| État | Rendu | Boutons |
|---|---|---|
| **Absent + read-only** | `field-help` "No Discord webhook…" | `EDIT` dans le header de section |
| **Présent + read-only** | `.cfg-kv` `DISCORD` / `<url>` | `EDIT` dans le header de section |
| **Édition (présent OU absent)** | `.field` `<label>WEBHOOK URL</label> <input type="url"> <field-help>…</field-help>` + (si présent) un bouton `REMOVE WEBHOOK` ambre/rouge sous l'input | `SAVE` + `CANCEL` dans le header |

### 5.2 Comportement EDIT

```tsx
function ConnectorsSection({ role, onPatch }) {
  const discord = role.connectors.find((c) => c.type === 'discord');
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(discord?.webhookUrl ?? '');
  const [error, setError] = useState<string | null>(null);
  const dirty = (discord?.webhookUrl ?? '') !== url;

  useEffect(() => {
    if (!editing) setUrl(discord?.webhookUrl ?? '');
  }, [discord, editing]);

  async function save() {
    setError(null);
    const u = url.trim();
    if (u && !/^https?:\/\//i.test(u)) {
      setError('Webhook URL must start with http(s)://');
      return;
    }
    const connectors = u ? [{ type: 'discord' as const, webhookUrl: u }] : [];
    try {
      await onPatch({ connectors });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function remove() {
    setUrl('');           // bouton "REMOVE WEBHOOK" → vide le champ + save direct
    void onPatch({ connectors: [] }).then(() => setEditing(false));
  }
  // …
}
```

### 5.3 Validation

- **URL** : `trim()` + check `https?://` (regex souple). Le serveur ne
  valide pas la cible (il fera juste un `fetch` au moment du notify),
  donc côté client on se limite à un check basique. Une variante stricte
  (`https://discord.com/api/webhooks/...`) est un plus mais peut bloquer
  des proxy/canary légitimes — laisser souple.
- **Empty save** : si l'utilisateur efface le champ et clique SAVE, on
  interprète comme "delete" (`{ connectors: [] }`). Pas d'erreur.
- **Bouton REMOVE** : confirmation via `ConfirmModal` recommandée pour
  éviter les fausses manip (mais simple `confirm()` natif suffisant v1).

### 5.4 Affichage de l'URL en read-only

Long, à `break-all` (cf. proto `modals.jsx:198`), font-size réduit
(10.5 px), couleur `var(--text-dim)` pour ne pas voler la vedette aux
sections plus importantes (PROMPT, PREAMBLE).

---

## 6. Composant complet (JSX final)

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useRoles } from '../hooks/useRoles';
import type { ConnectorView, RoleView, RoleInput } from '../api/client';

interface Props {
  /** Quand `false`, l'overlay n'est pas monté. Permet à l'extérieur
   *  (DesktopShell ou App.tsx) de contrôler son cycle de vie. */
  open: boolean;
  /** Appelé quand l'utilisateur clique "← BACK TO MAP" ou demande la
   *  fermeture. Le parent doit basculer la route vers `#/`. */
  onClose: () => void;
}

const MODELS = [
  { value: '', label: '(inherit global default)' },
  { value: 'claude-opus-4-7', label: 'opus-4-7' },
  { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
  { value: 'claude-haiku-4-5-20251001', label: 'haiku-4-5' },
] as const;
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const PERMS = [
  '',
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const;

type SectionId =
  | 'defaults'
  | 'leadPrompt'
  | 'leadPreamble'
  | 'workerPreamble'
  | 'connectors';

export function RolesPage({ open, onClose }: Props) {
  const { roles, loading, error, create, update, destroy } = useRoles();
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<SectionId | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  // Présélection + auto-fallback si le role courant a disparu.
  useEffect(() => {
    if (selectedRoleId == null && roles.length > 0) {
      setSelectedRoleId(roles[0].id);
      return;
    }
    if (selectedRoleId != null && !roles.find((r) => r.id === selectedRoleId)) {
      setSelectedRoleId(roles[0]?.id ?? null);
      setEditingSection(null);
    }
  }, [roles, selectedRoleId]);

  const role = useMemo(
    () => roles.find((r) => r.id === selectedRoleId) ?? null,
    [roles, selectedRoleId],
  );

  function tryClose() {
    if (editingSection && !confirm('Discard unsaved changes in this role?')) return;
    setEditingSection(null);
    onClose();
  }

  function trySelect(id: string) {
    if (id === selectedRoleId) return;
    if (editingSection && !confirm('Discard unsaved changes?')) return;
    setEditingSection(null);
    setSelectedRoleId(id);
  }

  async function patchSelected(body: Partial<RoleInput>): Promise<void> {
    if (!role) return;
    setOpError(null);
    try {
      await update(role.id, body);
      setEditingSection(null);
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async function newRole() {
    const label = prompt('Label for the new role (lower-case, no spaces):');
    if (!label || !label.trim()) return;
    try {
      const r = await create({ label: label.trim(), connectors: [] });
      setSelectedRoleId(r.id);
      setEditingSection(null);
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  }

  async function duplicateRole() {
    if (!role) return;
    try {
      const r = await create({
        label: `${role.label} (copy)`,
        leadPrompt: role.leadPrompt,
        leadPreamble: role.leadPreamble,
        workerPreamble: role.workerPreamble,
        workerCount: role.workerCount,
        defaultModel: role.defaultModel,
        defaultEffort: role.defaultEffort,
        defaultPermissionMode: role.defaultPermissionMode,
        connectors: role.connectors,
      });
      setSelectedRoleId(r.id);
      setEditingSection(null);
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteRole() {
    if (!role) return;
    if (!confirm(`Delete role "${role.label}"? Existing orchestrators are not affected.`)) return;
    try {
      await destroy(role.id);
      // selectedRoleId fallback handled by the useEffect above.
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!open) return null;

  return (
    <div className="roles-overlay" onClick={(e) => e.stopPropagation()}>
      <aside className="roles-side">
        <div className="roles-side-head">
          <button className="back" onClick={tryClose}>← BACK TO MAP</button>
          <div className="title">ROLES</div>
          <div className="sub">templates for spawning new teams</div>
        </div>

        <div className="roles-list">
          {loading && roles.length === 0 && (
            <div className="field-help" style={{ padding: '14px 20px' }}>loading…</div>
          )}
          {error && (
            <div className="field-warn" style={{ margin: 12 }}>{error}</div>
          )}
          {!loading && roles.length === 0 && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              No roles yet — click "+ NEW ROLE" below.
            </div>
          )}
          {roles.map((r) => (
            <div
              key={r.id}
              className={`role-item ${selectedRoleId === r.id ? 'active' : ''}`}
              onClick={() => trySelect(r.id)}
            >
              <div className="r-name">{r.label.toUpperCase()}</div>
              <div className="r-id">{r.id}</div>
              <div className="r-tags">
                {r.workerCount != null && r.workerCount > 0 && (
                  <span className="tag-pill">{r.workerCount} WRK</span>
                )}
                {r.defaultModel && (
                  <span className="tag-pill model">
                    {r.defaultModel.replace(/^claude-/, '')}
                  </span>
                )}
                {r.defaultEffort && (
                  <span className="tag-pill">E:{r.defaultEffort}</span>
                )}
                {r.connectors.find((c) => c.type === 'discord') && (
                  <span className="tag-pill discord">DISCORD</span>
                )}
                {r.leadPrompt && <span className="tag-pill">LEAD-PROMPT</span>}
              </div>
            </div>
          ))}
        </div>

        <div className="roles-add">
          <button className="btn" style={{ flex: 1 }} onClick={() => void newRole()}>
            + NEW ROLE
          </button>
        </div>
      </aside>

      <main className="roles-main">
        {role ? (
          <>
            <h2>{role.label.toUpperCase()}</h2>
            <div className="role-id">{role.id}</div>

            {opError && (
              <div
                className="field-warn"
                role="alert"
                style={{
                  color: 'var(--bad)',
                  borderLeftColor: 'var(--bad)',
                  background: 'rgba(224, 101, 74, 0.06)',
                  marginBottom: 20,
                }}
              >
                {opError}
              </div>
            )}

            <DefaultsSection
              role={role}
              editing={editingSection === 'defaults'}
              onEdit={() => setEditingSection('defaults')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <LeadPromptSection
              role={role}
              editing={editingSection === 'leadPrompt'}
              onEdit={() => setEditingSection('leadPrompt')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <PreambleSection
              kind="lead"
              role={role}
              editing={editingSection === 'leadPreamble'}
              onEdit={() => setEditingSection('leadPreamble')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <PreambleSection
              kind="worker"
              role={role}
              editing={editingSection === 'workerPreamble'}
              onEdit={() => setEditingSection('workerPreamble')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <ConnectorsSection
              role={role}
              editing={editingSection === 'connectors'}
              onEdit={() => setEditingSection('connectors')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <div style={{ display: 'flex', gap: 10, marginTop: 30 }}>
              <button className="btn" onClick={() => void duplicateRole()}>
                DUPLICATE
              </button>
              <button className="btn danger" onClick={() => void deleteRole()}>
                DELETE
              </button>
            </div>
          </>
        ) : (
          <div className="field-help">No role selected.</div>
        )}
      </main>
    </div>
  );
}

// ---------- DEFAULTS ----------
function DefaultsSection({
  role,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const [workerCount, setWorkerCount] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [effort, setEffort] = useState<string>('');
  const [perm, setPerm] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWorkerCount(role.workerCount != null ? String(role.workerCount) : '');
    setModel(role.defaultModel ?? '');
    setEffort(role.defaultEffort ?? '');
    setPerm(role.defaultPermissionMode ?? '');
    setError(null);
  }, [role.id, editing]);

  async function save() {
    setError(null);
    let parsed: number | null = null;
    if (workerCount.trim()) {
      const n = Number.parseInt(workerCount, 10);
      if (!Number.isInteger(n) || n < 0) {
        setError('workerCount must be a non-negative integer');
        return;
      }
      parsed = n;
    }
    try {
      await onSave({
        workerCount: parsed,
        defaultModel: model || null,
        defaultEffort: (effort || null) as RoleInput['defaultEffort'],
        defaultPermissionMode: perm || null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>DEFAULTS</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>CANCEL</button>
            <button className="h-edit" onClick={() => void save()} style={{ color: 'var(--amber)' }}>
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>EDIT</button>
        )}
      </h3>

      {!editing ? (
        <div className="cfg-kv">
          <span className="k">WORKER COUNT</span>
          <span className="v">{role.workerCount ?? '— (inherit)'}</span>
          <span className="k">MODEL</span>
          <span className="v">{role.defaultModel ?? '— (inherit)'}</span>
          <span className="k">EFFORT</span>
          <span className="v">{role.defaultEffort ?? '— (inherit)'}</span>
          <span className="k">PERMISSION</span>
          <span
            className="v"
            style={{
              color: role.defaultPermissionMode === 'bypassPermissions'
                ? 'var(--warn)' : 'var(--text)',
            }}
          >
            {role.defaultPermissionMode ?? '— (inherit)'}
          </span>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label>WORKER COUNT</label>
            <input
              type="number"
              min={0}
              value={workerCount}
              onChange={(e) => setWorkerCount(e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="field">
            <label>MODEL</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>EFFORT</label>
            <div className="seg-radio">
              {EFFORTS.map((ef) => (
                <button
                  key={ef || '(inherit)'}
                  type="button"
                  className={effort === ef ? 'on' : ''}
                  onClick={() => setEffort(ef)}
                >
                  {ef || 'inherit'}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>PERMISSION</label>
            <select value={perm} onChange={(e) => setPerm(e.target.value)}>
              {PERMS.map((p) => (
                <option key={p || '(inherit)'} value={p}>{p || '(inherit)'}</option>
              ))}
            </select>
            {perm === 'bypassPermissions' && (
              <div className="field-warn">
                ⚠ bypassPermissions :: agents in teams using this role will skip ALL permission prompts.
              </div>
            )}
          </div>
          {error && (
            <div
              className="field-warn"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)', background: 'rgba(224,101,74,0.06)' }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- LEAD PROMPT ----------
function LeadPromptSection({
  role,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const [draft, setDraft] = useState(role.leadPrompt ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(role.leadPrompt ?? '');
    setError(null);
  }, [role.id, editing]);

  async function save() {
    setError(null);
    try {
      await onSave({ leadPrompt: draft.trim() ? draft : null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>LEAD PROMPT</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>CANCEL</button>
            <button className="h-edit" onClick={() => void save()} style={{ color: 'var(--amber)' }}>
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>EDIT</button>
        )}
      </h3>

      {!editing ? (
        <div className="cfg-pre">{role.leadPrompt || '— (none) —'}</div>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What the lead should focus on by default."
            style={{ width: '100%', minHeight: 140 }}
          />
          {error && (
            <div
              className="field-warn"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}
            >
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------- LEAD / WORKER PREAMBLE ----------
function PreambleSection({
  kind,
  role,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  kind: 'lead' | 'worker';
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const current = kind === 'lead' ? role.leadPreamble : role.workerPreamble;
  const title = kind === 'lead' ? 'LEAD PREAMBLE' : 'WORKER PREAMBLE';
  const [draft, setDraft] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(current ?? '');
    setError(null);
  }, [role.id, current, editing]);

  async function save() {
    setError(null);
    const value = draft.trim() ? draft : null;
    const body: Partial<RoleInput> =
      kind === 'lead' ? { leadPreamble: value } : { workerPreamble: value };
    try {
      await onSave(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>{title}</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>CANCEL</button>
            <button className="h-edit" onClick={() => void save()} style={{ color: 'var(--amber)' }}>
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>EDIT</button>
        )}
      </h3>

      {!editing ? (
        <div className="cfg-pre">{current || '— (none) —'}</div>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              kind === 'lead'
                ? 'System preamble injected before the lead prompt. Inherited at team creation unless overridden.'
                : "System preamble for workers spawned in teams using this role. Overridable per worker via team.spawn_worker(preamble=…)."
            }
            style={{ width: '100%', minHeight: 140 }}
          />
          {error && (
            <div
              className="field-warn"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}
            >
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------- CONNECTORS ----------
function ConnectorsSection({
  role,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const discord = role.connectors.find((c) => c.type === 'discord');
  const [url, setUrl] = useState(discord?.webhookUrl ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(discord?.webhookUrl ?? '');
    setError(null);
  }, [role.id, discord?.webhookUrl, editing]);

  async function save() {
    setError(null);
    const u = url.trim();
    if (u && !/^https?:\/\//i.test(u)) {
      setError('Webhook URL must start with http:// or https://');
      return;
    }
    const connectors: ConnectorView[] = u
      ? [{ type: 'discord', webhookUrl: u }]
      : [];
    try {
      await onSave({ connectors });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove() {
    if (!confirm('Remove Discord webhook from this role?')) return;
    setError(null);
    try {
      await onSave({ connectors: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>CONNECTORS</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>CANCEL</button>
            <button className="h-edit" onClick={() => void save()} style={{ color: 'var(--amber)' }}>
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>EDIT</button>
        )}
      </h3>

      {!editing ? (
        discord ? (
          <div className="cfg-kv">
            <span className="k">DISCORD</span>
            <span
              className="v"
              style={{ fontSize: 10.5, color: 'var(--text-dim)', wordBreak: 'break-all' }}
            >
              {discord.webhookUrl}
            </span>
          </div>
        ) : (
          <div className="field-help">
            No Discord webhook. Configure to relay session-waiting events to a channel.
          </div>
        )
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label>DISCORD WEBHOOK URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
            />
            <div className="field-help">
              When set, orchestrators created with this role route their notifications
              to this webhook instead of the global one. Leave empty to remove.
            </div>
          </div>
          {discord && (
            <button
              className="btn danger"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void remove()}
            >
              REMOVE WEBHOOK
            </button>
          )}
          {error && (
            <div
              className="field-warn"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Notes d'implémentation**

- L'export reste `RolesPage` (pas de rename), pour ne pas casser
  `App.tsx:5` (`import { RolesPage } from './components/RolesPage'`).
  La signature passe de `()` à `({ open, onClose }: Props)` — la mise à
  jour du caller est trivial (cf. §8).
- L'inline EDIT pour DEFAULTS, LEAD PROMPT, LEAD PREAMBLE, WORKER
  PREAMBLE et CONNECTORS envoie systématiquement un `PATCH` **partiel**
  (seulement les clés qui changent). C'est conforme au contrat
  `api.updateRole(id, body: Partial<RoleInput>)`.
- Le `label` du role **n'est PAS éditable** dans la v2 (le proto ne
  l'expose pas non plus). Pour le renommer, il faut DUPLICATE + DELETE.
  Si c'est jugé trop limitant, ajouter une 6ᵉ section "IDENTITY" avec
  un champ `label` (PATCH possible côté backend) — follow-up optionnel,
  hors scope strict du proto.
- Le bouton DUPLICATE crée immédiatement le role côté serveur avec
  label `<orig> (copy)` puis le sélectionne. L'utilisateur peut ensuite
  ouvrir chaque section pour ajuster.
- Le bouton DELETE utilise `confirm()` natif comme dans l'existant —
  remplacer par `ConfirmModal` v2 quand celui-ci sera implémenté
  (Étape 14).

---

## 7. Suppression de `RoleDialog` — peut-on le supprimer ?

### 7.1 Inventaire des usages restants

```bash
$ grep -rn "RoleDialog" packages/web/src/
packages/web/src/components/RolesPage.tsx:3:import { RoleDialog } from './RoleDialog';
packages/web/src/components/RolesPage.tsx:115:      <RoleDialog .../>
packages/web/src/components/RoleDialog.tsx:44:export function RoleDialog(...)
packages/web/src/components/NewOrchestratorDialog.tsx:4:import { RoleDialog } from './RoleDialog';
packages/web/src/components/NewOrchestratorDialog.tsx:240:      <RoleDialog .../>
```

Après C.10, le retrait de `RoleDialog` dans `RolesPage` laisse **un seul
usage** : `NewOrchestratorDialog.tsx` (l'option `+ create new role…`
de la dropdown ROLE, cf. Étape 9 §5).

### 7.2 Décision

**Ne pas supprimer `RoleDialog.tsx` à l'Étape 10.** Le composant reste
utilisé par `NewOrchestratorDialog` pour le flux de création rapide
"+ create new role". Le supprimer impliquerait soit :

- **(A) Refactor parallèle** : extraire un composant `RoleForm` partagé
  utilisé par (1) la section EDIT de chaque section dans `RolesPage`
  (mais le découpage section-par-section ne se prête pas à un formulaire
  monolithique) et (2) `NewOrchestratorDialog` (qui a besoin d'un
  formulaire compact, c'est-à-dire exactement ce que `RoleDialog` est
  aujourd'hui). Aboutirait à dupliquer du code ou à introduire une
  abstraction prématurée.
- **(B) Bouger le flux "+ create new role" hors de `NewOrchestratorDialog`** :
  rediriger l'utilisateur vers l'overlay `RolesPage` pour créer un
  nouveau role, puis revenir à la création d'orchestrator. UX dégradée
  (perte de contexte, perte de la saisie en cours).

Aucune des deux options n'est satisfaisante à court terme. **Conserver
`RoleDialog` tel quel** pour C.10, le porter au thème v2 dans le même
geste si c'est rapide (15 min de réécriture des classes Tailwind →
classes v2 — c'est essentiellement un copier-coller du layout proto
`NewOrchestratorDialog`), ou le laisser en l'état (modale Tailwind dans
un océan v2) le temps qu'un follow-up dédié l'épure.

### 7.3 Plan de retrait éventuel (post-v1)

1. Extraire `RoleForm.tsx` (champs sans wrapper modal).
2. `NewOrchestratorDialog` réutilise `RoleForm` à l'intérieur de son
   propre `<div className="modal">` (sous-modale ou expansion en place).
3. Supprimer `RoleDialog.tsx`.

À planifier dans la dette technique, ticket "Unify role editing flows".

### 7.4 Modifications minimales de `RoleDialog.tsx` (optionnelles, hors scope strict)

- Ajouter le `style={{ zIndex: 110 }}` ou un prop `containerStyle` pour
  empiler proprement au-dessus de `NewOrchestratorDialog` v2 (déjà
  documenté dans 09_new-orchestrator-dialog.md §5.2).
- Aucun autre changement nécessaire pour C.10.

---

## 8. Plan d'implémentation pas-à-pas

1. **Pré-requis Étape 1** : vérifier que `packages/web/src/styles/desktop-theme.css` (ou équivalent) contient les classes :
   - `.roles-overlay`, `.roles-side`, `.roles-side-head`, `.roles-side-head .back/.title/.sub`, `.roles-list`, `.role-item`, `.role-item.active`, `.role-item .r-name/.r-id/.r-tags`
   - `.tag-pill`, `.tag-pill.discord`, `.tag-pill.model`
   - `.roles-add`, `.roles-main`, `.roles-main h2`, `.roles-main .role-id`
   - `.role-section`, `.role-section h3`, `.role-section h3 .h-edit`
   - `.cfg-kv`, `.cfg-kv .k/.v`, `.cfg-pre`
   - `.field`, `.field-row`, `.field-3`, `.field-help`, `.field-warn`
   - `.seg-radio`, `.btn`, `.btn.danger`
   
   Source de vérité : extrait du `<style>` de `/tmp/v2-extract/Swarm OS v2.html` lignes 580-917 (couvrent `cfg-*`, `field-*`, modal/btn) et 826-917 (couvrent `roles-*`, `role-*`, `tag-pill`, sections). Si absentes, les porter dans `desktop-theme.css` avant C.10.

2. **Réécriture en place** de `packages/web/src/components/RolesPage.tsx` avec le code de §6. Conserver l'export `RolesPage`. Modifier la signature de `()` à `({ open, onClose })`.

3. **Mise à jour du caller `App.tsx`** :
   - `App.tsx:187` actuel : `{route.kind === 'roles' && <RolesPage />}`.
   - Nouveau : `<RolesPage open={route.kind === 'roles'} onClose={() => setRoute({ kind: 'list' })} />`.
   - L'overlay étant `position: fixed`, on peut le rendre **inconditionnellement** au niveau du composant racine (et utiliser `open` pour gate son rendu interne). Variante : laisser le `{route.kind === 'roles' && …}` qui démonte le composant — choix de l'implémenteur. La version "render always + gate via `open`" facilite les animations enter/leave futures.
   - Quand l'Étape 4 livre la TopBar v2, ajouter le bouton ROLES qui appelle le même `setRoute({ kind: 'roles' })` (déjà documenté dans 04_topbar-data-binding.md).

4. **Suppression des imports inutiles** :
   - `RolesPage.tsx` : retirer `import { RoleDialog } from './RoleDialog'` (l'inline EDIT remplace).
   - Conserver `import type { ConnectorView, RoleView, RoleInput } from '../api/client'` (utilisés par les sections).
   - Conserver `import { useRoles } from '../hooks/useRoles'`.

5. **Tests** :
   - Aucun test n'existe actuellement pour `RolesPage.tsx`. C'est l'occasion d'en ajouter (cf. §9.2 — bonus). À défaut, vérifier que le smoke-test global de l'app passe.

6. **QA visuelle** (cf. workflow Docker dans `MEMORY.md`) :
   - `docker build -t swarm-os:latest .`
   - `docker compose -f docker-compose.test.yml up -d`
   - Naviguer vers `http://localhost:8080/#/roles` ; vérifier le rendu overlay 56-px-from-top, sidebar 320 px, main 1fr.
   - Tester les 5 sections EDIT (DEFAULTS, LEAD PROMPT, LEAD PREAMBLE, WORKER PREAMBLE, CONNECTORS).
   - Tester DUPLICATE et DELETE.
   - Tester l'ouverture depuis le bouton ROLES de la TopBar (si l'Étape 4 est livrée) — sinon, depuis l'URL `#/roles` directement.

7. **Documentation** : aucun changement à `docs/ui-redesign-desktop.md` (déjà à jour, §3.5 et §5.1 step 10 référencent ce port).

---

## 9. Tests de fumée

À jouer **manuellement** dans l'app dockerisée après build.

### 9.1 Smoke tests UX

1. **Ouverture overlay** : naviguer vers `#/roles` → l'overlay s'affiche
   (fond opaque, TopBar reste visible en haut, sidebar 320 px à gauche
   avec la liste, main à droite avec le détail du premier role).
   Si la TopBar v2 est livrée : cliquer son bouton `ROLES` → même effet.
2. **Sélection** : cliquer un autre role dans la sidebar → le main se
   met à jour ; le role cliqué prend la classe `.active` (bordure
   gauche ambrée). Le précédent perd `.active`.
3. **Section DEFAULTS — EDIT/CANCEL** : cliquer `EDIT` sur DEFAULTS →
   la section passe en mode form (4 champs : workerCount,
   model, effort, perm). Modifier `effort` → cliquer `CANCEL` → la
   section retombe en read-only, la valeur originale est conservée
   (vérifier que `PATCH /roles/:id` n'a PAS été appelé via `Network`).
4. **Section DEFAULTS — EDIT/SAVE** : ré-ouvrir DEFAULTS, changer
   `workerCount` de `0` à `3` → cliquer `SAVE` → réseau : 1 `PATCH /roles/:id`
   avec `{ workerCount: 3, defaultModel: ..., defaultEffort: ..., defaultPermissionMode: ... }` → la section retombe en read-only, affiche `3` ; la sidebar affiche `3 WRK` tag-pill.
5. **Section DEFAULTS — validation** : ouvrir EDIT, taper `workerCount=-2` → cliquer SAVE → `.field-warn` rouge "workerCount must be a non-negative integer", pas d'appel réseau.
6. **Section DEFAULTS — bypassPermissions warning** : choisir `perm=bypassPermissions` → `.field-warn` ambré apparaît dans la section. Choisir autre chose → le warning disparaît.
7. **Section LEAD PROMPT — EDIT/SAVE** : EDIT → modifier le texte → SAVE → `PATCH` `{ leadPrompt: '<nouveau>' }` envoyé ; read-only affiche le nouveau texte dans `.cfg-pre` ; tag-pill `LEAD-PROMPT` apparaît dans la sidebar si pas déjà présent.
8. **Section LEAD PROMPT — empty save** : EDIT → vider le textarea → SAVE → `PATCH` `{ leadPrompt: null }` envoyé ; read-only affiche `— (none) —` ; tag-pill `LEAD-PROMPT` disparaît.
9. **Sections LEAD PREAMBLE / WORKER PREAMBLE** : mêmes tests que LEAD PROMPT, mutatis mutandis.
10. **Section CONNECTORS — add** : sur un role sans webhook, EDIT → coller `https://discord.com/api/webhooks/123/abc` → SAVE → `PATCH` `{ connectors: [{ type: 'discord', webhookUrl: '...' }] }` → read-only affiche `DISCORD <url>` ; tag-pill `DISCORD` ambre apparaît dans la sidebar.
11. **Section CONNECTORS — edit** : EDIT → changer l'URL → SAVE → `PATCH` même structure avec nouvelle URL ; read-only à jour.
12. **Section CONNECTORS — validation** : EDIT → taper `not-an-url` → SAVE → `.field-warn` rouge "Webhook URL must start with http://…".
13. **Section CONNECTORS — remove via empty save** : EDIT → vider le champ → SAVE → `PATCH` `{ connectors: [] }` → read-only affiche le `field-help` "No Discord webhook…" ; tag-pill `DISCORD` disparaît.
14. **Section CONNECTORS — REMOVE WEBHOOK button** : EDIT (avec webhook présent) → cliquer `REMOVE WEBHOOK` → `confirm()` natif → OK → `PATCH` `{ connectors: [] }` même résultat que 13.
15. **+ NEW ROLE** : cliquer en bas de la sidebar → `prompt()` "Label for the new role" → entrer `tester` → `POST /roles { label: 'tester', connectors: [] }` → le nouveau role apparaît en bas de la liste, est auto-sélectionné, le main affiche les sections vides (`— (none) —` partout, `— (inherit)` pour les defaults).
16. **DUPLICATE** : avec un role rempli sélectionné, cliquer `DUPLICATE` → `POST /roles { label: '<orig> (copy)', leadPrompt: ..., connectors: [...] }` → la copie apparaît dans la sidebar, est auto-sélectionnée, le main affiche les mêmes contenus que l'original.
17. **DELETE** : cliquer `DELETE` → `confirm()` natif → OK → `DELETE /roles/:id` → le role disparaît de la sidebar ; auto-fallback sur le premier role restant (ou état vide si c'était le dernier).
18. **Fermeture** : cliquer `← BACK TO MAP` → l'overlay se démonte (ou se cache via `open=false` selon implémentation) ; la route bascule à `#/`.
19. **Fermeture avec dirty state** : EDIT LEAD PROMPT, taper du texte sans sauver → cliquer `← BACK TO MAP` → `confirm()` "Discard unsaved changes…" → ANNULER → l'overlay reste ouvert avec l'édition en cours.
20. **Sélection avec dirty state** : EDIT LEAD PROMPT non sauvé → cliquer un autre role dans la sidebar → `confirm()` "Discard unsaved changes?" → ANNULER → le role sélectionné ne change pas, l'édition continue.
21. **Refresh externe** : pendant qu'on est en read-only sur un role, attendre 5 s (poll `useRoles`) → la sidebar se rafraîchit, le détail aussi (sans flicker visible si les tags/valeurs n'ont pas changé). Pendant qu'on est en EDIT, attendre 5 s → l'édition n'est PAS écrasée (vérifier que la valeur du textarea reste intacte).
22. **Empty state** : supprimer tous les roles → la sidebar affiche `No roles yet — click "+ NEW ROLE" below.` ; le main affiche `No role selected.` ; seul `+ NEW ROLE` reste cliquable.
23. **Loading initial** : recharger la page avec une connexion lente (DevTools throttling) → la sidebar affiche `loading…` jusqu'à la résolution du premier `GET /roles`.
24. **Erreur initiale** : couper la connexion réseau → recharger → la sidebar affiche un `.field-warn` ambré avec le message de l'erreur (`Failed to fetch` ou similaire).
25. **Cohabitation avec NewOrchestratorDialog** : depuis `#/` (liste orchestrators), cliquer `+ NEW TEAM` → modale Étape 9 s'ouvre → dropdown ROLE → `+ create new role…` → `RoleDialog` (ancien, non porté) s'ouvre par-dessus. Créer un role → le nouveau role apparaît dans la dropdown ET dans la sidebar de `RolesPage` quand on retourne sur `#/roles`. **Garantit que les deux flux de création coexistent.**

### 9.2 Tests Vitest (bonus, non bloquants)

À créer `packages/web/src/components/RolesPage.test.tsx` :

```ts
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RolesPage } from './RolesPage';

// Mocker useRoles pour fournir des fixtures contrôlées.
vi.mock('../hooks/useRoles', () => ({
  useRoles: () => ({
    roles: [{ id: 'r1', label: 'researcher', leadPrompt: null, /* ... */ }],
    loading: false, error: null,
    refresh: vi.fn(), create: vi.fn(), update: vi.fn(), destroy: vi.fn(),
  }),
}));

describe('RolesPage', () => {
  it('does not render when open=false', () => {
    const { container } = render(<RolesPage open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the overlay with the first role auto-selected', () => {
    render(<RolesPage open={true} onClose={() => {}} />);
    expect(screen.getByText(/← BACK TO MAP/)).toBeInTheDocument();
    expect(screen.getByText(/RESEARCHER/i)).toBeInTheDocument();
  });

  it('switches sections to EDIT mode on click', () => {
    render(<RolesPage open={true} onClose={() => {}} />);
    const editBtns = screen.getAllByText('EDIT');
    fireEvent.click(editBtns[1]); // LEAD PROMPT
    expect(screen.getByText('SAVE')).toBeInTheDocument();
    expect(screen.getByText('CANCEL')).toBeInTheDocument();
  });

  it('calls update with a partial PATCH on SAVE', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'r1', /* ... */ });
    vi.mocked(useRoles).mockReturnValue({ /* ... */ update });
    render(<RolesPage open={true} onClose={() => {}} />);
    // EDIT LEAD PROMPT → tape "hello" → SAVE
    fireEvent.click(screen.getAllByText('EDIT')[1]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('SAVE'));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('r1', { leadPrompt: 'hello' });
    });
  });

  it('calls onClose when "BACK TO MAP" is clicked', () => {
    const onClose = vi.fn();
    render(<RolesPage open={true} onClose={onClose} />);
    fireEvent.click(screen.getByText(/← BACK TO MAP/));
    expect(onClose).toHaveBeenCalled();
  });
});
```

(À budgétiser séparément — non bloquant pour C.10.)

---

## 10. Récap des fichiers touchés

| Fichier | Action |
|---|---|
| `packages/web/src/components/RolesPage.tsx` | **Réécriture intégrale** (export `RolesPage`, signature passe de `()` à `({open, onClose})`) |
| `packages/web/src/App.tsx` | Patch ligne 187 : `<RolesPage open={route.kind === 'roles'} onClose={() => setRoute({ kind: 'list' })} />` (1-ligne) |
| `packages/web/src/components/RoleDialog.tsx` | **Conservé** (utilisé par `NewOrchestratorDialog`) — pas de changement pour C.10 |
| `packages/web/src/hooks/useRoles.ts` | **Aucun changement** |
| `packages/web/src/api/client.ts` | **Aucun changement** (`updateRole`, `createRole`, `deleteRole`, `listRoles` déjà exposés ; types `RoleView`, `RoleInput`, `ConnectorView` déjà alignés) |
| `packages/web/src/styles/desktop-theme.css` | **Aucun changement si Étape 1 est complète**. Sinon, ajouter les classes `.roles-*`, `.role-item*`, `.tag-pill*`, `.role-section*`, `.cfg-kv*`, `.cfg-pre`, `.h-edit`, `.field-warn`, `.btn.danger` (cf. §8 pt 1) |
| `packages/web/src/components/desktop/TopBar.tsx` (à venir Étape 4) | Le bouton `ROLES` doit déclencher `setRoute({ kind: 'roles' })` — déjà documenté dans 04_topbar-data-binding.md, à valider quand l'Étape 4 livre |

---

## 11. Ce que cette étape NE fait PAS

- Pas de changement backend (`/roles` CRUD déjà disponible et idempotent sur les PATCH partiels).
- Pas de suppression de `RoleDialog.tsx` (cf. §7).
- Pas de portage du `RoleDialog.tsx` au thème v2 (à traiter dans Étape 9 ou follow-up — cohabitation visuelle temporaire acceptable).
- Pas de support multi-connecteurs (Slack, PagerDuty…). Section CONNECTORS limitée à Discord — extensible plus tard (1 sous-section par type).
- Pas d'édition du `label` du role en place. Pour renommer : DUPLICATE puis DELETE l'original. Si jugé limitant, ajouter une 6ᵉ section "IDENTITY" en follow-up.
- Pas de focus trap, pas de gestion du `ESC` pour fermer (à traiter dans un follow-up "modal accessibility" global commun à toutes les modales v2).
- Pas de remplacement de `confirm()` natifs par `ConfirmModal` v2 (à faire quand l'Étape 14 livre `ConfirmModal`).
- Pas d'undo après DELETE (irréversible côté client — le backend supprime hard).
- Pas de migration vers `DesktopShell` (réservée à l'Étape 3). L'overlay reste pour l'instant monté depuis `App.tsx` directement, à côté du `<main>` qui rend `OrchestratorList`/`OrchestratorView`.

---

## 12. Risques & points d'attention

1. **Cohabitation Tailwind ↔ CSS v2** : la nouvelle `RolesPage` utilise exclusivement les classes v2 (`.roles-overlay`, `.role-section`, etc.) ; aucune classe Tailwind n'est plus nécessaire dans ce composant. Vérifier que Tailwind ne purge pas les classes v2 (configurer une safelist si besoin — cf. risque §5.4 du doc parent).
2. **z-index** : `.roles-overlay` a `z-index: 60`. Quand l'Étape 11 livrera `SettingsDrawer` avec `z-index: 70`, le drawer apparaîtra **au-dessus** de l'overlay roles — comportement souhaité (l'utilisateur peut ouvrir Settings depuis n'importe quelle vue, y compris depuis Roles).
3. **Conflit avec `NewOrchestratorDialog v2`** : `.modal-backdrop` est à `z-index: 100`, donc une `NewOrchestratorDialog` ouverte par-dessus une `RolesPage` ouverte sera bien au-dessus. Cas d'usage rare (l'utilisateur ouvre Roles puis quelque chose lance une création d'orchestrator — peu probable), mais visuellement correct.
4. **`useRoles` poll 5 s** : pendant l'édition, on **gèle** les buffers locaux (cf. §3.2). C'est nécessaire mais cela signifie que si un autre client modifie le même role en parallèle, l'utilisateur écrasera ses changements à la sauvegarde. La v1 n'a pas de gestion d'ETag/If-Match — accepter le last-write-wins.
5. **Pattern "edit one section at a time"** : si un utilisateur clique EDIT sur une section pendant qu'une autre est en édition, le `confirm()` natif est gênant. Compromis acceptable v1 ; améliorable avec un `ConfirmModal` v2 (Étape 14).
6. **`label` non-éditable** : décision de design héritée du proto. Si l'opérateur s'attend à pouvoir renommer un role en place, il sera frustré. Documenter dans une infobulle ou un `field-help` près du `<h2>` : "label is immutable — duplicate + delete to rename".
7. **`alert/confirm/prompt` natifs** : 4 usages dans le code (`newRole`, `duplicateRole`, `deleteRole`, `trySelect`, `tryClose`, `ConnectorsSection.remove`). Cohérent avec l'existant (`RolesPage.tsx` actuelle utilise `confirm()` au DELETE), mais à remplacer par un composant unifié v2 dans un follow-up.
8. **Pré-requis Étape 1** : présupposé fort que `desktop-theme.css` est en place. Si non, c'est l'Étape 0 du jour : ajouter les ~90 lignes de CSS `.roles-*` extraites de `Swarm OS v2.html:826-917` avant d'attaquer C.10.
9. **`useEffect([role.id, editing])` dans les sections** : reset des buffers au changement de role OU au passage en édition. Si l'utilisateur EDIT puis CANCEL, on veut que les buffers se ré-initialisent depuis `role` — c'est ce que fait `useEffect([role.id, editing])` (le passage `editing: true → false` re-déclenche l'effet). Vérifier en QA qu'aucun cycle infini ne se produit.
10. **Compatibilité avec future TopBar v2** : le bouton `ROLES` de la TopBar (Étape 4) doit appeler la même action que `setRoute({ kind: 'roles' })`. Le doc 04_topbar-data-binding.md doit lier ce point. Si déjà livré : vérifier que `tryClose()` retombe bien sur `#/` et non sur une route fantôme.
