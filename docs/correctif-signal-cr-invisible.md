# Correctif — le `\r` de tête des injections PTY annule l'envoi (Claude Code ≥ 2.1.277)

> Statut : **appliqué** sur la branche `fix/signal-cr-invisible` (issue de `d1d63da`),
> reste à valider sur un agent réel (§5). Contournement en place sur l'instance `stiix`
> depuis le 2026-09-22 20:31Z (voir [§6](#6-contournement-en-place-à-retirer-après-déploiement)).
> Rédigé le 2026-09-22 à partir du diagnostic de la panne du pipeline stiix.
>
> Note d'application : le §4.3 (`clearDialogPending`) a été appliqué à l'intégration de
> `feature/discord-hourglass-reactions` (merge de master, 2026-09-23).

## 1. Résumé

swarm-os tape ses injections dans le PTY sous la forme `\r<texte>`, puis un `\r` seul
150 ms plus tard (`SIGNAL_WRITE_WINDOW_MS`). Depuis **Claude Code 2.1.277**, le TUI
contrôle le texte saisi au moment de l'envoi. Un **CR non suivi d'un LF** y est compté
comme un « caractère invisible » : il est retiré et **l'envoi est annulé**.

```
Removed 1 invisible character · review and press Enter to send
```

Le `\r` de **tête** atterrit dans la zone de saisie. Le `\r` d'envoi est donc refusé, le
signal reste affiché et l'agent ne lit jamais sa boîte. Seul un **second** Entrée, tapé
à la main, passe, puisque le texte a déjà été nettoyé.

**Correction : ne plus préfixer les injections par `\r` pour les fournisseurs Ink
(`inkSubmitDance: true`).** Cela concerne deux endroits de `session.ts`.

## 2. Symptôme observé (instance `stiix`, 2026-09-21 → 2026-09-22)

- **Pendant 33 h (du 21/09 04:41Z au 22/09 14:12Z), aucun message n'a été remis à un
  lead.** `mailbox_messages.delivered_at` reste `NULL` alors que les crons tirent
  normalement (100 ticks Analyst empilés).
- Effet en chaîne :
  - l'Analyst ne lit plus les rapports `QUALIFIE` de ses workers ;
  - aucun ticket ne reçoit le label `criteres-ok` ;
  - le cron `developper-dispatch` reste en `skip` (« 0 candidats »).
- Dans le log PTY (`/data/logs/<orch>/<session>.log`), chaque signal est suivi de :
  ```
  ❯ [swarm-os] new message in inbox — call team.read_inbox to fetch
    Removed 1 invisible character · review and press Enter to send
  ```
- Un Entrée humain dans la console débloque **un seul** cycle, puis le signal suivant se
  bloque de la même façon.
- Les **workers** sont touchés aussi. Le worker `cadrage-FYRA-2045` (lancé le 22/09 à
  14:13Z) s'est bloqué dès son premier signal.
- Un redémarrage du conteneur n'y change rien : les agents repartent sur la version
  installée, qui a le même filtre.

Requête de diagnostic :

```sql
SELECT o.name, s.name, count(*), min(m.ts)
  FROM mailbox_messages m
  JOIN sessions s ON s.id = m.to_session_id
  JOIN orchestrators o ON o.id = s.orchestrator_id
 WHERE m.delivered_at IS NULL AND s.status = 'running' AND s.hidden_at IS NULL
 GROUP BY s.id;
```

## 3. Cause

### 3.1 Le filtre de Claude Code

Extrait du binaire 2.1.280 (code minifié, noms tels quels) :

```js
// hbe : message affiché
function hbe(e, n = "review", r = "Enter") {
  let i = e === 1 ? "Removed 1 invisible character" : `Removed ${e} invisible characters`;
  switch (n) { case "review": return `${i} · review and press ${r} to send`; /* … */ }
}

// hZe : nettoyage de la saisie ; Hr = terminateurs de ligne
function Hr(e) { return e===10||e===11||e===12||e===13||e===133||e===8232||e===8233 }
// … dans la boucle de hZe :
if (Hr(N)) {
  let re = N === 13 && r.charCodeAt(I) === 10;      // CR suivi de LF : toléré
  if (!re) i.push("\n"), h++, n.other++, /* … */;  // sinon : compté comme retiré
}
```

Un `\r` (13) qui n'est pas suivi de `\n` incrémente `removedTotal`. Tout compte non nul
fait passer l'envoi en mode `review`, c'est-à-dire qu'il est annulé.

### 3.2 La version en cause

Présence de la chaîne `review and press` dans les binaires installés :

| Version | Filtre présent |
|---|---|
| 2.1.261 | non |
| 2.1.265 | non |
| 2.1.277 | **oui** |
| 2.1.278 | **oui** |
| 2.1.280 | **oui** |

Les agents stiix tournaient en **2.1.259** jusqu'au redémarrage du conteneur du
2026-09-21 à 04:41Z. Ils ont alors été relancés en **2.1.278**, que la mise à jour
automatique avait installé le 09-20. La panne commence exactement à ce redémarrage.

### 3.3 Le coupable dans swarm-os

Le seul CR que swarm-os envoie **dans un bloc de texte** est le CR de tête :

- `notifySignal` (`session.ts:1437` dans le working tree, `:1240` dans `HEAD`) :
  ```ts
  const intro = dance ? `\r${text}` : `\r${text}\r`;
  ```
  Toutes les injections serveur passent par là : signal de boîte aux lettres
  (`signalInbox`) et avis opérateur (`_scheduleNotice` → `notifySignal`).
- Injection de réinitialisation de contexte (`/compact`, `/clear`), `session.ts:1829` :
  ```ts
  const intro = `\r${line}`;
  ```

Le `\r` d'envoi, écrit seul 150 ms plus tard, reste nécessaire et n'est pas en cause.
C'est lui qui produit le vrai appui sur Entrée.

### 3.4 Limite du diagnostic (à connaître)

Dans un PTY de test (session neuve, après un tour, via `ssh -tt` multiplexé, protocole
clavier kitty actif, reprise d'une transcription de 264k tokens), l'injection
`\r`+texte / `\r` **a été soumise correctement** en 2.1.278 : dans ces conditions, le
`\r` de tête n'arrive pas dans la saisie. Sur les agents réels, si. Seule différence
repérée : les agents réels affichent une **suggestion de prompt** (texte fantôme, par
exemple `❯ attends le prochain tick`) au moment de l'injection. Cette condition n'a
pas été isolée.

La chaîne causale repose donc sur les points suivants, tous établis :

- le filtre compte un CR isolé (code) ;
- il n'existe qu'à partir de 2.1.277 (binaires) ;
- le message apparaît sur chaque signal bloqué (logs) ;
- le seul CR en bloc de texte envoyé par swarm-os est celui de tête (code).

Piste probable pour l'écart test / réel, lue dans le parseur d'entrée de 2.1.280 : un
octet de contrôle n'est traité comme une touche que si le bloc reçu fait **moins de 64
caractères** (`!s&&a<32&&(u.length<64||…)`). Au-delà, le bloc entier, `\r` compris, est
inséré comme du texte. Le signal de boîte aux lettres fait 63 caractères : avec le `\r` de tête, le bloc en fait
**exactement 64**, pile au seuil. Il part donc en collage et le CR atterrit dans la
saisie. Un avis opérateur ou un `/compact` avec instructions dépasse aussi ce seuil. Un
texte de test plus court que 63 caractères n'aurait pas reproduit la panne.

En revanche, **le correctif n'a pas encore été validé sur un agent réel.** Voir §5.

## 4. Correction à appliquer

### 4.1 `packages/server/src/modules/orchestrator/session.ts` — `notifySignal`

```diff
   notifySignal(text: string): void {
     // Providers without an Ink TUI submit fine from a single chunk, so they
     // get `\r<text>\r` in one write instead of the two-step cadence.
     const dance = this.provider.capabilities.inkSubmitDance;
-    const intro = dance ? `\r${text}` : `\r${text}\r`;
+    // No LEADING CR for Ink providers: since Claude Code 2.1.277 a CR not
+    // followed by LF inside the prompt counts as an "invisible character" —
+    // the TUI strips it and CANCELS the submit ("review and press Enter to
+    // send"), leaving the signal typed but never sent
+    // (docs/correctif-signal-cr-invisible.md).
+    const intro = dance ? text : `\r${text}\r`;
```

Mettre à jour le JSDoc de `notifySignal`, qui décrit encore « `\r${text}\r` » comme
l'ancienne forme.

### 4.2 Même fichier — injection de réinitialisation de contexte (~l. 1829)

```diff
-    const intro = `\r${line}`;
+    const intro = this.provider.capabilities.inkSubmitDance ? line : `\r${line}`;
```

Un `/compact` ou un `/clear` injecté avec un CR de tête tombe sous le même filtre : la
commande reste tapée et n'est pas exécutée.

### 4.3 Commentaire à corriger — `clearDialogPending` (~l. 1596)

Le commentaire décrit le signal comme `\r[swarm-os] new message…\r`, « whose LEADING
`\r` submits that one-character answer ». Une fois le CR de tête supprimé, ce danger
disparaît. Garder le re-basage de `_idleSince`, qui reste utile (le signal atterrirait
**dans** la réponse partielle au lieu de la soumettre), et reformuler.

### 4.4 Tests à adapter

- `session.test.ts:549` : `expect(fake.writes[idx]).toBe(\`\r${NOTICE}\`)` devient
  `toBe(NOTICE)`.
- Chercher les autres assertions sur la forme `\r<texte>` pour un fournisseur
  `inkSubmitDance: true` (`fake` a `inkSubmitDance: true`). Par exemple :
  `grep -rn "\\\\r\${" packages/server/src --include=*.test.ts`.
- `fake.test.ts:91` (`'\rinbox: 1 new\r'`) teste la branche **sans** dance : pas de
  changement.
- **Ajouter un test de non-régression** : pour un fournisseur `inkSubmitDance: true`,
  aucune écriture de `notifySignal`, ni de la réinitialisation de contexte, ne doit
  **commencer** par `\r`. La seule écriture contenant un CR doit être le `'\r'` seul.

### 4.5 Hors périmètre

La branche sans dance (`\r${text}\r`, fournisseurs non-Ink comme opencode) n'est pas
concernée : ces TUI n'ont pas ce filtre. Ne pas y toucher sans mesure.

## 5. Validation

1. Tests unitaires : `session.test.ts`, `idle-boundary.test.ts`,
   `auto-compact.orchestrator.test.ts`, `fake.test.ts`, `skills/activation.test.ts`,
   `crons/scheduler.test.ts`.
2. **Sur un agent réel avec Claude Code ≥ 2.1.277** (c'est la validation qui compte,
   cf. §3.4). Après déploiement, **arrêter d'abord le contournement** (§6), sinon il
   masquera un échec. Ensuite :
   - vérifier que le tick cron suivant a `delivered_at` rempli **dans les secondes**
     qui suivent `ts` ;
   - vérifier que le log PTY ne contient plus `Removed 1 invisible character` après
     les signaux postérieurs au déploiement ;
   - vérifier un `/compact` (auto ou `team.context_compact`) : la commande s'exécute
     (`session.context_reset_fired`, puis un contexte réduit).

## 6. Contournement en place (à retirer après déploiement)

Sur l'hôte, en dehors de ce dépôt :

- `~/.swarm-os/stiix/watchdog/signal_nudge.py`, lancé chaque minute par la crontab de
  l'utilisateur `ubuntu` ;
- journal : `~/.swarm-os/stiix/watchdog/watchdog.log`.

Le script envoie `\r` seul via `POST /sessions/:id/input`, c'est-à-dire le second
Entrée, aux conditions suivantes :

- courrier non remis depuis plus de 45 s ;
- signal visible comme dernier événement du log, sans tour ni dialogue après lui ;
- pas de relance de la même session depuis 2 min.

Premier effet mesuré : lead Analyst relancé à 20:31:12Z, boîte lue à 20:31:14Z ; lead
DEVELOPERS relancé à 20:34:02Z, 3 messages remis à 20:34:04Z.

Pour le retirer après validation : supprimer la ligne `signal_nudge.py` de
`crontab -e` (utilisateur `ubuntu`).

## 7. Précautions de déploiement

- **Construire depuis un commit propre.** Au 2026-09-22, le working tree porte environ
  98 fichiers modifiés et non commités (branche `feature/discord-hourglass-reactions`),
  dont `session.ts`. Appliquer le correctif sur une branche issue du dernier commit, ou
  attendre que ce travail soit commité. Ne pas reconstruire l'image depuis le working
  tree tel quel.
- **Un redémarrage perd le courrier en attente.** Au boot du 2026-09-22 à 19:41Z, les
  messages non lus ont été marqués `delivered_at` sans être livrés
  (`boot.auto_resume … mailboxRehydrated: 0`). Le lead DEVELOPERS a ainsi perdu une
  offre de dispatch (FYRA-2046). Déployer quand aucune boîte n'a de message en attente
  (requête du §2), ou traiter ce défaut à part.
- Un redémarrage **rejoue le prompt de lancement** des agents : prévenir les équipes
  concernées si du travail est en cours.

## Annexe — hypothèses écartées pendant le diagnostic

| Hypothèse | Verdict | Mesure |
|---|---|---|
| L'auto-compact de swarm-os bloque la reprise | écartée | leads à 11–17 % (`below-threshold`) ; aucun `/compact` sur l'Analyst depuis le redémarrage |
| Le préambule est perdu au compact | écartée | il est passé en `--append-system-prompt` (prompt système), qu'aucun compact n'efface |
| Verrou `dialogPending` (D5) | écartée | aucun événement `session.dialog_pending` ; les signaux sont bien tapés |
| La cadence de 150 ms est trop courte | non concluante | un bloc `\r<texte>\r` fusionné est soumis en test PTY (2.1.261 et 2.1.278) |
| Le chemin `ssh -tt` + ControlMaster | écartée | injection soumise par le même chemin ssh multiplexé |
| Protocole clavier kitty / focus-out | écartée | injection soumise avec `ESC[?5u` répondu, et après `ESC[O` |
| Taille du contexte | écartée | injection soumise sur la reprise d'une copie de la transcription du lead (264k tokens) |
