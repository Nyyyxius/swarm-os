# Écrire une histoire avec NovelAI — méthode

Ce fichier est la source unique du guide. `novelai.writing_guide` renvoie
exactement ce texte ; il est aussi copié dans ton workspace au moment où le
plugin est activé.

## Le principe, en une phrase

NovelAI **continue un texte**, il ne répond pas à une consigne. Il n'existe
aucun champ « instruction » : le modèle reçoit une seule chaîne et écrit la
suite. Diriger l'histoire, c'est donc écrire la direction **dans** cette chaîne,
à l'endroit où elle pèse le plus.

Tu n'as pas à fabriquer cette chaîne : passe `story`, `memory` et
`authors_note` à `novelai.generate_text` et le plugin l'assemble correctement.

## Écris en anglais — ce n'est pas une préférence de style

**Tout ce que tu envoies à NovelAI doit être en anglais** : `story`, `memory`,
`authors_note`, `attg`, `opening`, et le texte de `generate_voice`.

Les modèles NovelAI sont entraînés sur un corpus de fiction **anglophone** —
Erato est un finetune de Llama 3 sur de la prose anglaise, et les voix TTS sont
anglophones. Dans une autre langue, rien ne casse : l'API répond `200`, le texte
est grammatical, et c'est précisément le problème. La prose devient plate,
répétitive, hors registre, et les tournures idiomatiques disparaissent. **Aucune
erreur ne te préviendra.**

La marche à suivre si l'utilisateur veut une histoire en français :

1. écris le plan, le Memory et les notes d'auteur **en anglais** ;
2. génère toute l'histoire **en anglais** ;
3. **traduis à la fin**, en une passe, quand le texte est figé.

Tu traduis bien mieux que NovelAI n'écrit en français. Traduire à la fin donne un
meilleur résultat que générer directement dans la langue cible.

Le plugin surveille ça : si ton contexte ne semble pas anglais, la réponse porte
un `warning`. C'est un indice, pas un blocage — il ne détecte pas tout.

## Ton rôle

Tu es le **directeur d'écriture**, pas l'écrivain. NovelAI tient la plume ; toi
tu tiens le plan, tu juges chaque paragraphe et tu décides de la suite. Tu ne
bloques jamais sur la page blanche : tu ne fais que choisir entre garder et
relancer.

## Préparation (une seule fois)

**1. Le plan.** Découpe l'histoire en 10 à 20 beats, une ligne chacun.
« Elara découvre le sceau tiède », « Cort avoue à moitié », « le roi meurt ».
C'est la colonne vertébrale ; elle ne change plus. Écris-la dans `plan.md`.

**2. Le Memory.** Dix lignes maximum, **en anglais** : qui sont les personnages,
où on est, les règles du monde, et la voix narrative (« third person, past tense,
Elara's point of view »). Ce bloc part à **chaque** appel. Écris-le dans
`memory.md`.

L'histoire s'écrit dans `histoire.md`, vide au départ.

## La boucle (un beat à la fois)

**3. Appelle l'outil.**

```json
{
  "story":        "<le contenu de histoire.md — en anglais>",
  "memory":       "<le contenu de memory.md — en anglais>",
  "authors_note": "Elara confronts Cort about his accent. He does not deny it. Terse.",
  "attg":         "Title: The Last Messenger; Tags: fantasy, betrayal; Genre: fantasy",
  "opening":      "She looked up at the messenger and",
  "max_length":   110
}
```

Envoie `story` **en entier** : le plugin garde tout seul la fin qui tient dans
la fenêtre du modèle.

**4. Juge la sortie.** C'est l'étape que toi seul peux faire :

- elle va dans le bon sens → garde-la ;
- elle part ailleurs → relance avec une `authors_note` plus directive ;
- elle est bonne sur trois phrases puis déraille → **coupe et garde les trois
  phrases**. C'est le cas le plus fréquent, et c'est normal.

**5. Ajoute au fichier.** Le morceau retenu s'ajoute à `histoire.md`.

**6. Nourris le Memory.** Si NovelAI vient d'inventer un détail que tu gardes —
une cicatrice, un nom, une dette — ajoute-le à `memory.md`. Sinon il sortira de
la fenêtre et le modèle l'aura oublié dans dix paragraphes.

Puis retour à l'étape 3 avec le beat suivant.

## Finition

**7. Relis tout** pour recoudre les jointures entre paragraphes et harmoniser
les noms. Là, tu écris vraiment.

## Les quatre erreurs qui font tout rater

**Ne rien mettre dans `memory`.** Les personnages sortent de la fenêtre et le
modèle les réinvente. `story` est la continuité récente ; `memory` est ce qui
ne doit jamais être oublié.

**Finir sur un point.** Un contexte qui se termine proprement invite le modèle à
changer de sujet, ou à écrire « Chapter 2 ». Donne toujours un `opening` coupé
en plein milieu : « She looked up at the messenger and ».

**Écrire une `authors_note` trop longue.** Au-delà de deux ou trois lignes, elle
concurrence la prose au lieu de la diriger. Une consigne, pas un résumé.

**Demander trop d'un coup.** 500 tokens, c'est trois paragraphes que personne
n'a relus, dont deux hors sujet. 110 tokens, c'est un paragraphe qu'on garde ou
qu'on jette tout de suite.

## Réglages utiles

| Paramètre | Effet |
|---|---|
| `max_length` | 110–250. Un paragraphe. Reprends la main souvent. |
| `temperature` | 0.8 pour une scène de mécanique, 1.1 pour de la description. Au-delà de 1.3 ça déraille. |
| `repetition_penalty` | 1.05–1.15 sur les textes longs. Sans lui, le modèle boucle sur ses propres tournures. |
| `stop_sequences` | Coupe la génération. Fiable sur les modèles récents (`xialong-v1`, `glm-4-6`). |
| langue | **Anglais** pour tout ce qui part vers NovelAI. Traduis à la fin. |
| `model` | `llama-3-erato-v1` par défaut. `xialong-v1` est plus récent. Le plugin route tout seul. |

## Ce que le plugin fait pour toi

- il garde la fin de `story` qui tient dans la fenêtre du modèle choisi ;
- il place `authors_note` à la profondeur où elle agit vraiment ;
- il remet `memory` et `attg` en tête à chaque appel ;
- il route vers la bonne API NovelAI selon le modèle, et se corrige tout seul
  s'il s'est trompé ;
- il te renvoie des `warnings` quand ton contexte a un défaut connu — lis-les,
  ils sont écrits pour le cas précis où tu te trouves.
