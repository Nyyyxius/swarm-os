# S12 — Mapping `MailMessageView.from` → bulle `me / them / system / other-team`

> Analyse d'implémentation détaillée pour le chantier S12 décrit dans
> `docs/update_system.md` (lignes 249-260). **Frontend uniquement.**
> Aucun changement serveur strictement nécessaire (mais voir §6 pour un
> élargissement utile du DTO côté client).

---

## 1. Résumé du besoin

Le RightPanel desktop affiche un onglet **MESSAGES** rendu en bulles
de chat (`prototypes/panels.jsx:259-264`). Le prototype distingue
visuellement `me` (opérateur, droite) de `them` (agent, gauche) et
mentionne déjà `system`. La source réelle sera la mailbox du serveur,
exposée par `peekInbox()` qui renvoie `MailMessageView`. La chaîne
`from` est **polymorphe** : `'human'`, `'system'`, ou une session-id
(peer intra-team ou cross-team). S12 formalise cette classification
dans une fonction pure réutilisable et documente la sémantique dans
`client.ts`.

---

## 2. État actuel

### Sémantique serveur du champ `from`

`packages/server/src/modules/orchestrator/mailbox.ts:24-43` définit
`Message.from: string`, avec le commentaire canonique : "Sender —
usually a session id, but may be `'system'` or `'human'`." Producteurs
en pratique :

- **`'human'`** : opérateur via `POST /orchestrators/:id/broadcast`
  (`http/routes/orchestrators.ts:307`). Source unique.
- **`'system'`** : généré par le serveur, p. ex. `index.ts:560` pour
  signaler la sortie anormale d'un worker au lead. Un producteur
  aujourd'hui, mais le commentaire mailbox l'élargit explicitement.
- **session-id (peer intra-team)** : via `team.send_message` /
  `team.broadcast` (`messaging.ts:165`, `:222`).
- **session-id (cross-team)** : via `swarm.send_to_lead` /
  `swarm.broadcast_to_leads` (`messaging.ts:324-329`, `:388-394`).
  Trois champs additionnels enrichissent ce cas :
  `fromOrchestratorId`, `fromOrchestratorName`, `fromSessionName`
  (`mailbox.ts:38-42`).

### Wire format côté client

`packages/web/src/api/client.ts:129-134` :

```ts
export interface MailMessageView { id: string; from: string; content: string; ts: string; }
```

**Constat fort** : le client **ne déclare pas** les champs
`fromOrchestratorId / fromOrchestratorName / fromSessionName` alors
que le serveur les sérialise tels quels (`orchestrators.ts:344-345`
fait `res.json({ count, messages })` sans projection). Ils sont
présents sur le wire mais invisibles pour TypeScript. S12 doit
corriger ça (additif, non-cassant).

### Usages actuels

`grep -rn "MailMessageView" packages/web/src/` → 2 lignes, dans
`client.ts` uniquement. `OrchestratorView.tsx:62-72` n'utilise que
`r.count`. **Aucun rendu de bulle existant** — pas de régression
possible.

---

## 3. Fichiers à modifier (frontend uniquement)

| Fichier | Nature |
|---|---|
| `packages/web/src/api/client.ts` | Étendre `MailMessageView` (3 champs optionnels). JSDoc enrichi sur `from`. |
| `packages/web/src/lib/messageBubble.ts` (nouveau, ~40 lignes) | Fonction pure `classifyBubble` + type `BubbleKind`. |
| `packages/web/src/lib/messageBubble.test.ts` (nouveau) | Tests unitaires (§5). |

Aucun composant React n'est touché par S12 — le rendu de l'onglet
MESSAGES est porté par un lot UI ultérieur (non listé dans
`update_system.md`, probablement côté `update_UI.md`).

---

## 4. Plan d'implémentation

### Signature

```ts
export type BubbleKind = 'me' | 'them' | 'system' | 'other-team';

export interface BubbleClassification {
  kind: BubbleKind;
  authorLabel: string;
  fromTeam?: { id: string; name: string; sessionName: string };
}

export function classifyBubble(
  msg: MailMessageView,
  currentSessionId: string,
): BubbleClassification;
```

### Règles (ordre d'évaluation important)

1. `msg.from === 'human'` → `me`, label `YOU`.
2. `msg.from === 'system'` (ou membre d'un set extensible
   `SYSTEM_FROM_VALUES`) → `system`, label `SYSTEM`.
3. `msg.fromOrchestratorId` présent → `other-team`, label
   `<name> / <sessionName>` (fallback session-id), `fromTeam` peuplé.
   **Heuristique** : la présence de ce champ est l'unique signal
   fiable du cross-team (`mailbox.ts:33-37` : "absent for intra-team
   messages"). On ne compare pas à l'orch courante.
4. Sinon → `them`, label = `fromSessionName` (si présent côté
   peer-intra-team enrichi, cf. §6) sinon préfixe court de la
   session-id (ex. `sess_abc12345` → `abc1`).

**Note sur S5 / cross-team** : le cross-team a été livré par le commit
`abc25f6` (cf. git log) ; le serveur émet déjà des entrées mailbox
enrichies. S12 doit **impérativement** supporter la 4ᵉ catégorie
`other-team`, sinon l'opérateur perd la trace de l'origine du message
— un message arrivé de "team Atlas" apparaîtrait identique à un peer
intra-team, ce qui casse le modèle mental.

---

## 5. Tests à écrire

`packages/web/src/lib/messageBubble.test.ts` — vitest, ~60 lignes :

1. `from='human'` → `me`, label `YOU`.
2. `from='system'` → `system`, label `SYSTEM`.
3. `from='sess_peer'`, pas de `fromOrchestratorId` → `them`, label
   dérivé de la session-id.
4. `from='sess_lead_atlas'`, `fromOrchestratorId='orch_atlas'`,
   `fromOrchestratorName='Atlas'`, `fromSessionName='lead-1'` →
   `other-team`, label `Atlas / lead-1`, `fromTeam.id='orch_atlas'`.
5. `from='sess_lead'`, `fromOrchestratorId` présent **mais**
   `fromSessionName` absent → label fallback sur `from`.
6. **Ordre de priorité** : `from='human'` + `fromOrchestratorId`
   présent (impossible côté serveur, mais défensif) → règle `human`
   gagne.
7. `from='sess_self'`, `currentSessionId='sess_self'` (cas dégénéré,
   impossible en l'état car le broadcast exclut `s.id === fromSid`,
   `messaging.ts:214`) → `them` par défaut (branche présente par
   défensive).

Pas de test sur le rendu React.

---

## 6. Gotchas

- **G1 — DTO web incomplet.** `MailMessageView` doit être étendu
  avant d'écrire la fonction, sinon la branche `other-team` n'est même
  pas typable. Non négociable.
- **G2 — Pas d'orchestrator-id courant en argument.** On se fie
  uniquement à la présence de `fromOrchestratorId` pour signer le
  cross-team. Passer un `currentOrchId` ouvrirait un risque de
  divergence si l'appelant le câble mal — le serveur garantit déjà
  l'absence du champ pour les intra-team.
- **G3 — Labels lisibles vs session-id bruts pour `them`.** Côté
  peer intra-team, le wire n'expose pas le `name` aujourd'hui. Trois
  options : (a) préfixe court de la session-id (S12, coût nul) ; (b)
  enrichir le serveur d'un `fromSessionName` symétrique au cas
  cross-team (follow-up, non-cassant) ; (c) résoudre côté composant
  via `orch.sessions[from].name` (couplage fort). **Décision** : (a)
  dans S12, (b) en follow-up.
- **G4 — Badge "from team X".** `classifyBubble` retourne `fromTeam` ;
  c'est le composant de rendu (hors S12) qui décide d'afficher un chip
  "← Atlas". S12 livre la primitive, pas le style. Le prototype ne
  montre pas encore ce cas.
- **G5 — `from` futur élargi.** Si on ajoute `from='timer'` demain, la
  branche par défaut tombe sur `them` — incorrect. On encode donc les
  sentinelles système dans un `Set` (`SYSTEM_FROM_VALUES`) pour
  extension facile. Coût quasi nul.
- **G6 — Tri et `ts`.** Hors scope S12. Le composant de rendu
  appellera son propre tri par `ts` croissant.

---

## 7. Dépendances

- **Aucune dépendance dure.** S12 peut être livré en isolation.
- **Synergie S3** (`03_statut_waiting.md`) : palette visuelle session,
  réutilisable pour colorer les bulles `other-team` par accent
  d'orch. Pas bloquant.
- **Synergie cross-team mergée** (commit `abc25f6`) : justifie la 4ᵉ
  catégorie `other-team` ; sans elle on perdrait l'information déjà
  présente sur le wire.
- **Précondition implicite** au futur lot "RightPanel MESSAGES tab"
  qui importera `classifyBubble`. S12 doit précéder ce lot UI.

---

## 8. Critères d'acceptation vérifiables

1. `MailMessageView` (`client.ts`) déclare les trois champs optionnels
   `fromOrchestratorId?`, `fromOrchestratorName?`, `fromSessionName?`,
   et le JSDoc cite explicitement les 4 catégories de `from`
   (`'human'`, `'system'`, session-id intra-team, session-id
   cross-team).
2. `classifyBubble` existe dans `packages/web/src/lib/messageBubble.ts`,
   exporte `BubbleKind = 'me' | 'them' | 'system' | 'other-team'`, est
   **pure** (pas d'I/O, pas de hook).
3. Les 7 tests unitaires de §5 passent
   (`pnpm -F @swarm-os/web test`).
4. `tsc --noEmit` passe sur le package web sans warning.
5. `git diff packages/server/` est vide pour ce lot.
6. Aucune dépendance ajoutée à `package.json`.
7. Le commentaire d'en-tête de `messageBubble.ts` renvoie vers
   `mailbox.ts:24-43` (sémantique autoritative du `from`) — règle de
   traçabilité partagée avec les lots précédents.
