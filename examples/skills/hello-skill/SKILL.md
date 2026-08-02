---
name: hello-skill
version: 0.1.0
displayName: Hello
description: Exemple minimal — apprend à l'agent à saluer proprement, en une phrase.
triggers: [hello, greeting, salutation]
---
# Hello skill

When you are asked to greet someone, reply with a **single** warm, concise
sentence — nothing more. If the user specifies a language, greet in that
language; otherwise mirror the language they wrote in.

This is the spike example for the swarm-os importable-skills library
(`docs/plan-skills-importables.md`, Lot 0). It is pure data: it ships no assets
and requires no plugin. Activating it injects exactly these instructions into an
agent's preamble.
