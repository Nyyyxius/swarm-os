# S11 — Console structurée avec niveaux

> Analyse en profondeur du lot **S11** de `docs/update_system.md`
> (lignes 227-247). Posture similaire à S3 (frontend-only,
> documentation > code). Aucun code de production produit ici.

---

## 1. Résumé du besoin

Le prototype desktop colore chaque ligne de la tab CONSOLE par
**niveau sémantique** `INFO / OK / WARN / ERR / SEND / RECV`
(`prototypes/Swarm OS.html:417-422` + `prototypes/panels.jsx:243-249`).
Aujourd'hui, le client production utilise `xterm.js` qui reçoit le
flux PTY **brut** depuis `/ws/sessions/:id` via la frame
`{ type:'data', data:string }` — aucun niveau, juste les bytes émis
par `claude`. S11 documente le choix : **(a)** garder xterm tel quel
en v1 (zéro coût), ou **(b)** parser les niveaux côté serveur dans
un chantier ultérieur. Recommandation : **(a)**.

---

## 2. État du code existant

### 2.1 Le WS terminal et son format de frame

- **Route serveur** : `packages/server/src/http/main.ts:176-198`
  match `^/ws/sessions/([^/]+)$`, consomme un ticket
  (`consumeTicket(...,'terminal')`), délègue à `TerminalHub`.
- **Hub** : `packages/server/src/http/ws/terminal.ts`. Un
  `TerminalRoom` par session, premier client = writer, suivants =
  readers (promotion auto à la déconnexion du writer).
- **Frames sortantes** :
  - `{ type:'attached', role, sessionId, status }` (ligne 47) ;
  - `{ type:'replay', lines: string[] }` — `getRecentLines(50)`
    (ligne 54) ;
  - `{ type:'data', data: string }` — chaque chunk PTY broadcasté
    par `session.onData(...)` (ligne 112-123) ;
  - `{ type:'role-changed', role }` (ligne 104) ;
  - `{ type:'exit', ts }` (ligne 25).

### 2.2 Le client xterm

`packages/web/src/components/Terminal.tsx:30-38` : instance `XTerm`
avec `scrollback:5000`, `convertEol:true`. Switch sur `o.type` dans
`onmessage` ; `case 'data'` → `term.write(o.data)`. **Les séquences
ANSI (CSI, OSC, couleurs, gras) sont passées telles quelles** à
xterm — exactement ce que `claude` émet sur son PTY. Coloration
native déjà fonctionnelle.

### 2.3 Le log persisté (chemin et cap 50 MB)

- **Constante** : `packages/server/src/modules/orchestrator/session.ts:18`
  `const LOG_CAP_BYTES = 50 * 1024 * 1024; // 50 MB per plan §15`.
- **Chemin** : `session.ts:225-227` →
  `<logsDir>/<orchestratorId>/<sessionId>.log`, avec
  `logsDir = <dataDir>/logs` (`config.ts:232`).
- **Cap/append** : `session.ts:866-905`. Si existant > 50 MB →
  `truncateSync(...,0)` au boot ; une fois `logBytes >= LOG_CAP_BYTES`,
  les writes suivants sont **droppés silencieusement** (ligne 894).
  Fichier = PTY brut, ANSI inclus.
- **Ring buffer mémoire parallèle** : `session.ts:193` +
  `getRecentLines(n=20)` (ligne 563) — `RING_BUFFER_LINES = 200`.
- **Endpoint REST existant** :
  `packages/server/src/http/routes/sessions.ts:49-100`
  `GET /sessions/:id/log` — sert le fichier brut en `text/plain`,
  ANSI compris. Pas de parsing. C'est l'endroit naturel où brancher
  un futur `/ws/sessions/:id/log` structuré.

### 2.4 Le proto qui colore les lignes

- `prototypes/Swarm OS.html:414-424` : styles
  `.console-line .lv.{INFO,OK,WARN,ERR,SEND,RECV}` →
  `--text-dim`, `--ok`, `--warn`, `--bad`, `--amber`, `#8ab6e0`.
- `prototypes/panels.jsx:236-250` : rendu `<div className="lv ${l.lv}">`.
- Données proto (`prototypes/data.jsx:128-155`) entièrement
  **synthétiques** — l'auteur les a inventées pour la démo, aucun
  rapport avec un output réel de `claude`.
- `prototypes/app.jsx:270` mappe `action→lv` à la main pour les
  events synthétiques d'opérateur. **Aucun parseur de format Claude
  dans le proto.**

### 2.5 Version Claude pinnée

`docs/composants.md:49`, `docs/phase-5-containerisation.md:44`,
`README.md:76` : binaire `claude` pinné **2.1.142**. Le format
d'output n'est pas un contrat public ; il bouge avec les minors.

---

## 3. Décision recommandée — Option (a)

**Choix v1 : garder xterm tel quel dans la tab CONSOLE. Zéro
changement backend, zéro changement WS, zéro nouveau test.**

### 3.1 Justifications

1. **L'ANSI passe déjà.** `Terminal.tsx:87` `term.write(o.data)`
   rend les couleurs Claude nativement. L'opérateur a déjà une
   coloration dense ; perdre le proto = perdre une stylisation
   inventée, pas une perte fonctionnelle.
2. **La taxonomie proto est synthétique.** Aucun champ `lv` n'existe
   nulle part dans le serveur. La dériver imposerait un parseur
   regex fragile (cf. §7.1).
3. **Format Claude non stable** (2.1.142 pinné mais bouge à chaque
   bump → re-baseline à chaque release Claude). Maintenance non
   négligeable, bug de parsing silencieux possible.
4. **(b) n'ajoute pas d'info.** Tout ce qu'un parseur extrairait
   (timestamp, niveau) est déjà visible dans le texte que xterm
   rend. Valeur ajoutée = uniformisation, pas information.
5. **Effort/valeur défavorable** vs S1/S5/S8 qui débloquent des UI
   actuellement vides.
6. **Le log brut reste accessible** via `GET /sessions/:id/log`
   (§2.3) pour audit/grep hors-ligne.

### 3.2 Conséquences acceptées

- Tab CONSOLE ≠ grille pixel-à-pixel du proto. Rendu xterm (police
  mono, ANSI Claude) au lieu de la grille `time | lv | msg`.
- Pas de filtre par niveau, pas de search-by-`lv`.
- **À documenter** dans `update_UI.md` : « tab CONSOLE = xterm, pas
  la grille proto ; couleurs ANSI émises par `claude`, pas
  serveur ».

---

## 4. Fichiers à modifier

### 4.1 Option (a) — **zéro fichier**

Aucune modification serveur, aucune modification client. La nouvelle
tab CONSOLE consomme `<Terminal sessionId={…} />` existant. À
documenter seulement dans `docs/update_UI.md` (chantier UI séparé).

### 4.2 Option (b) — esquisse (chantier ultérieur)

Préférer la sous-option **(b.2)** recommandée par S11 — endpoint
WS dédié `/ws/sessions/:id/log` qui tail le fichier persisté :

| Chemin absolu | Modification |
|---|---|
| `packages/server/src/modules/orchestrator/log-parser.ts` (**nouveau**) | `parseLine(raw): { ts; lv; msg } \| null`. Regex anchored sur patterns Claude 2.1.142. Null → ligne reste raw. ANSI-strip systématique de `msg`. |
| `packages/server/src/modules/orchestrator/log-parser.test.ts` (**nouveau**) | Vitest, fixtures = échantillons réels annotés. |
| `packages/server/src/http/ws/log.ts` (**nouveau**) | `LogStreamHub` ~ `TerminalHub`. À l'attach, ouvre le `<dataDir>/logs/.../<sessionId>.log` (path via `spawner.findSession`, fallback DB comme `routes/sessions.ts:53-71`), tail incremental (`fs.watch` + seek), parse chaque ligne, émet `{ type:'structured', ts, lv, msg }`. |
| `packages/server/src/http/main.ts` | Brancher `/ws/sessions/:id/log` dans `http.on('upgrade')` (ligne 171). |
| `packages/server/src/http/routes/ws-ticket.ts` | Ajouter scope `'log'`. |
| `packages/web/src/components/StructuredConsole.tsx` (**nouveau**) | Ouvre `/ws/sessions/:id/log?ticket=…`, render grille proto (`panels.jsx:243-249`). |

Alternative (b.1) — émettre `{type:'structured'}` **en plus** de
`{type:'data'}` sur `/ws/sessions/:id` existant — rejetée : pollue
le hot-path PTY → xterm, mélange deux responsabilités (live PTY +
audit structuré).

(Chemins sous `/home/ubuntu/projets/swarm-os/`.)

---

## 5. Plan d'implémentation

### 5.1 v1 — option (a) : utiliser xterm tel quel

Travail effectif = **zéro code**. Action unique : documenter le
mapping proto → réel dans `docs/update_UI.md` pour éviter qu'on
réimplémente la grille proto par méprise. Section à ajouter :

> **Tab CONSOLE** : rendu par `<Terminal>` (xterm.js). Le proto
> affiche une grille `time | lv | msg` colorée par niveau —
> **ce rendu n'est pas reproduit** en v1. À la place, xterm
> reçoit le flux PTY brut depuis `/ws/sessions/:id`, avec
> coloration ANSI native émise par `claude`. La taxonomie proto
> `INFO/OK/WARN/ERR/SEND/RECV` est synthétique (proto-only).

### 5.2 Bricolage client optionnel (ANSI passthrough déjà fonctionnel)

Si un opérateur veut **sans backend** un filtrage par mot-clé :
possible via overlay React au-dessus du buffer xterm en lecture
(`term.buffer.active`). Hors livrable v1, mais documenté comme
chemin de fuite si S11(b) jamais demandé sans budget serveur.

### 5.3 Format de frame structurée (si v2)

```json
{ "type": "structured",
  "ts":  "2025-12-01T14:23:11.482Z",
  "lv":  "INFO",
  "msg": "compile :: target=swarm.bin step 3/9" }
```

`ts` ISO 8601 UTC, `lv` ∈ enum strict (6 valeurs), `msg` ANSI-stripped.

---

## 6. Tests

### 6.1 Option (a) — aucun nouveau test

Contrat WS terminal couvert par
`packages/server/test/integration/ws-terminal.test.ts`. Aucun ajout.
Non-régression : vérifier seulement que `Terminal.tsx` continue de
rendre le PTY brut.

### 6.2 Option (b) — pour mémoire

`log-parser.test.ts` (table de fixtures, ≥ 5 par niveau, ≥ 5
unmatched) + `ws-log.test.ts` (intégration). Tests
Claude-version-gated : skip si `CLAUDE_CODE_VERSION !== '2.1.142'`.

---

## 7. Gotchas

### 7.1 Maintenance regex (si option b)

Format `claude` non public. Chaque bump (cf.
`phase-5-containerisation.md:44` « Bumper… ») peut casser le parseur
sans erreur visible — la console "perd ses couleurs" silencieusement.
Mitigations : (a) test e2e versionné, (b) fallback `lv='INFO'` sur
lignes non matchées (déjà prévu : `parseLine→null`), (c) compteur
`parse_unmatched_total` exposé via `/metrics` pour détecter le drift.

### 7.2 Format Claude pinné 2.1.142

`docs/composants.md:49` confirme. Toute analyse S11(b) doit être
**datée** : régresser sur 2.1.142, puis re-baseline à 2.2.x. Sans ce
process, S11(b) devient une dette.

### 7.3 ANSI escape passthrough déjà fonctionnel

`Terminal.tsx:87` `term.write(o.data)` injecte les bytes directement,
y compris CSI/OSC. **C'est déjà la solution.** Toute personne croyant
que la tab CONSOLE est "monochrome" se trompe — elle est colorée par
Claude lui-même. Documenter pour éviter de réinventer une coloration
serveur en doublon de ce qu'`claude` émet déjà.

### 7.4 Le proto a inventé sa taxonomie

`prototypes/data.jsx:128-155` mélange `INFO/OK/WARN/ERR/SEND/RECV`
de façon synthétique pour une démo. Aucun mapping 1:1 avec un output
réel. **Ne pas promettre implicitement** à l'opérateur que la tab
CONSOLE classera ses lignes — sauf si S11(b) est livré.

### 7.5 Ring buffer (50/200 lignes) ≠ log persisté

`session.ts:563` `getRecentLines(50)` est utilisé au `replay` initial
(`terminal.ts:54-57`). Si S11(b.2) tail le fichier, le client peut
recevoir des lignes que xterm n'a pas reçues (lignes antérieures au
ring 200). Inverse aussi possible (ring contient des bytes mid-line
non flushés). À garder en tête pour sync xterm vs structured panel.

### 7.6 Cap 50 MB / drop silencieux

`session.ts:894-897` drop les writes une fois le cap atteint. Un
parseur (b.2) qui tail le fichier ne verra plus rien — comportement
attendu (session "muette" jusqu'au prochain spawn qui truncate). À
documenter dans la spec b.2.

### 7.7 Sécurité `msg` dans frame structurée

Si option (b) jamais livrée : `msg` peut contenir des ANSI résiduels.
Décision : **ANSI-strip systématique** dans `parseLine`
(`/\x1b\[[0-9;]*[A-Za-z]/g → ''`) avant émission de la frame.

---

## 8. Dépendances

**Aucune dure.** Indépendant de S1-S10 et S12 :

- S1/S2 concernent la mailbox, pas le PTY.
- S5 (actions session) n'influence pas le format console.
- S6 (idle), S12 (mapping `from` MESSAGES) sans rapport.

**Latente** : si S11(b.2) jamais livré, il **lit** le fichier log
produit par `session.ts` (Phase 4, plan §15) — composant existant
indépendamment de S11.

---

## 9. Critères d'acceptation vérifiables

### 9.1 Option (a) — v1 recommandée

Le lot S11 est **clôturé** si :

1. `docs/update_UI.md` documente explicitement que la tab CONSOLE
   = xterm (pas la grille proto), avec renvoi à `Terminal.tsx`.
2. La nouvelle UI desktop monte `<Terminal sessionId={…} />` dans
   la tab CONSOLE — pas de réimplémentation custom.
3. Aucun fichier serveur sous `packages/server/src/` n'est modifié.
4. `pnpm -w test && pnpm -w typecheck && pnpm -w lint` passent
   (trivial : zéro diff).
5. Vérif manuelle : ouvrir une session, voir les couleurs Claude
   natives (gras, dim, codes ANSI) ; confirmer que
   `getRecentLines(50)` est rejoué au refresh
   (`terminal.ts:54-57`).
6. Non-régression :
   `packages/server/test/integration/ws-terminal.test.ts` passe
   sans modification.

### 9.2 Option (b) — chantier futur (pour mémoire)

7. `parseLine` couvert par ≥ 30 fixtures (≥ 5 par niveau, ≥ 5
   `null`).
8. Frame `{ type:'structured', ts, lv, msg }` émise sur
   `/ws/sessions/:id/log` ; xterm sur `/ws/sessions/:id` inchangé.
9. ANSI-strip appliqué à `msg` (test : aucun `\x1b[` sortant).
10. Compteur `parse_unmatched_total` exposé pour détecter drift.
11. Tests Claude-version-gated (skip si version ≠ 2.1.142).

---

## 10. Conclusion

S11 est le seul lot d'`update_system.md` dont la recommandation est
de **ne rien faire côté backend en v1**. L'ANSI passthrough actuel
(`Terminal.tsx` + xterm) couvre le besoin "voir l'output Claude
coloré" sans coût additionnel. La taxonomie proto
`INFO/OK/WARN/ERR/SEND/RECV` est un artefact graphique sans source
backend ; la reproduire imposerait un parseur fragile à maintenir à
chaque bump de `claude` (pinné `2.1.142`). Le log persisté
(`<dataDir>/logs/.../sess.log`, cap 50 MB) reste accessible via
`GET /sessions/:id/log` pour audit hors-ligne. Si la console
structurée devient explicitement demandée, préférer la sous-option
**b.2** (endpoint WS dédié `/ws/sessions/:id/log` qui tail le
fichier persisté) plutôt que polluer le hot-path PTY → xterm.
