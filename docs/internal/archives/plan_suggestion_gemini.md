# Suggestions et Améliorations — swarm-os

Suite à l'analyse du `plan.md`, voici les recommandations pour sécuriser et optimiser l'implémentation.

## 1. Communication inter-sessions (Architecture)

**Problème :** L'injection directe dans le PTY `stdin` via `team.send_message` est imprévisible si une tâche est en cours (ex: un test qui attend une entrée, ou un long build).

**Suggestion :**
- Passer d'un mode "Push Stdin" à un mode **"Mailbox MCP"**.
- **Outil MCP `team.get_messages`** : Les sessions appellent cet outil pour récupérer les nouveaux messages.
- **Preamble adaptif** : Demander explicitement aux workers de vérifier leur mailbox après chaque tâche importante ou périodiquement.
- **Notification passive** : Si on veut vraiment "pousser", n'injecter dans le PTY que si on détecte une inactivité (absence de sortie pendant X secondes + pattern de prompt), mais l'approche MCP tool est plus robuste.

## 2. Détection de l'état "Waiting for Human"

**Problème :** Le plan mentionne un "hook Notification global". Il faut s'assurer que `claude` CLI supporte nativement un webhook.

**Vérification/Correction :**
- Si `claude` ne supporte pas de webhook HTTP, il faudra intercepter les séquences d'échappement ou les patterns de sortie spécifiques (ex: `(y/n)`, `Press enter`) dans le flux du PTY.
- Alternative : Utiliser l'environnement `CLAUDE_CODE_NOTIFICATION_CMD` si disponible pour déclencher un `curl` vers le serveur `swarm-os`.

## 3. Sécurité et Réseau

**Recommandations :**
- **Egress Filtering** : Même en MVP, il est conseillé de limiter ce que les agents peuvent télécharger. Un agent pourrait par mégarde (ou via une injection de prompt) exfiltrer les credentials `.claude` (montés en RO mais lisibles).
- **Audit Log** : En plus des logs de session, créer un log centralisé de toutes les commandes shell exécutées par TOUS les workers pour une supervision rapide sans ouvrir chaque terminal.

## 4. Robustesse du Spawner (Phase 1/2)

**Ajouts suggérés :**
- **Max Turns / Budget** : Ajouter une limite optionnelle de messages/coût par orchestrateur pour éviter qu'une boucle infinie entre deux agents ne consomme tout le quota.
- **Healthcheck PTY** : Détecter si un processus `claude` est "zombie" ou bloqué et proposer un "Hard Restart" de la session dans l'UI sans perdre l'orchestrateur.

## 5. Interface Utilisateur (Phase 3/6)

**Améliorations UX :**
- **Vue "Split Screen"** : Pouvoir afficher le terminal du Lead et d'un Worker côte à côte.
- **Quick Input** : Un champ de texte "Global Broadcast" pour parler à toute l'équipe sans s'attacher à un terminal spécifique.
- **Indicateur de coût (estimé)** : Si possible, afficher une estimation du nombre de tokens consommés par l'équipe (via parsing des logs si Claude les affiche, ou via une estimation grossière).

## 6. Détails Techniques (Correction Plan)

- **MCP Transport** : Le plan mentionne "Streamable HTTP". Pour être 100% compatible avec le SDK MCP, il vaut mieux implémenter le transport **SSE (Server-Sent Events)** pour les notifications serveur -> client.
- **SQLite** : Ajouter un index sur `orchestrator_id` dans la table `sessions` pour les instances avec beaucoup de workers.

## 7. Cycle de vie des Workers

**Précision nécessaire :**
- Si un worker spawn une sous-tâche qui échoue, comment le lead est-il prévenu ?
- **Suggestion** : Implémenter un "Exit Hook" qui envoie automatiquement un message `team-comms` au Lead quand un de ses Workers meurt, incluant l'exit code et les 5 dernières lignes de log.

---
*Ces suggestions visent à transformer le "Safe YOLO" en un système de production personnelle fiable.*
