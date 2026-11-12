# Internal design notes

These are the working documents written while swarm-os was built: the original
specification, phase reports, implementation plans, analyses and a post-mortem.
They are kept for history and to explain *why* the code looks the way it does.

- They are **not user documentation**. For that, see the
  [documentation index](../README.md).
- They are **mostly in French** and are not being translated.
- They describe the state of the code **when they were written**. File paths,
  line numbers, names and statuses in them are often out of date; the code is
  the source of truth.
- They may mention the original author's own deployments by name.

## Layout

| Directory | Contents |
|---|---|
| [plans/](plans/) | The original MVP specification (`plan.md`) and the plans for the plugin system (`plan_plugins.md`) and the update system (`plan_updates.md`). Source comments citing "plan.md §N" refer to `plans/plan.md`. |
| [archives/](archives/) | Earlier revisions of the MVP plan and the review suggestions it went through. |
| [phases/](phases/) | Implementation reports for MVP phases 0 to 7. |
| [ui-redesign/](ui-redesign/) | The desktop and mobile UI redesign: integration plans, the features added to the backend (`update_system.md`, `update_system/`) and to the prototype (`update_UI.md`), and the step-by-step desktop plan (`redesign-desktop/`). Source comments citing "update_system S1" or "D.5" refer to these. |
| [skills/](skills/) | Analysis, implementation plan and frozen HTTP contracts of the importable skills library. |
| [designs/](designs/) | Design proposals not covered elsewhere, such as the self-improvement plan (`auto-amelioration.md`, not implemented). |
| [analyses/](analyses/) | Comparison with Hermes Agent that drove the memory, task board, approvals and code graph work. |
| [post-mortems/](post-mortems/) | Diagnosis and fix of the invisible carriage-return bug in PTY injections (Claude Code 2.1.277). |
