/**
 * A reduced, VERBATIM slice of `https://models.dev/api.json` (snapshot taken
 * 2026-07-28), plus a handful of deliberately broken entries appended at the
 * end of each provider.
 *
 * Verbatim matters: every id, `release_date`, `cost` and `modalities` block
 * below was copied out of the live payload rather than invented, so a test that
 * asserts "`claude-opus-5` wins the opus family" is asserting against the shape
 * the server will actually meet — not against a shape we wished for. The full
 * payload is 3.2 MB and 173 providers; committing it would make every diff of
 * this file unreadable and would freeze a moving target in git.
 *
 * WHAT EACH ENTRY IS HERE TO PROVE (do not prune without reading):
 *   anthropic
 *     claude-opus-5                    newest opus → wins `BUILTIN_PROVIDER_DEFAULT_FAMILIES.claude`
 *                                      + carries `limit.context` (monitoring, Lot 2)
 *                                      + all FOUR prices, incl. `cache_read`/`cache_write`
 *                                        → the complete rate card of Lot 11's `costUsd`
 *     claude-sonnet-5                  newer than opus-4-8 but NOT in the opus family
 *                                      + a `limit.context` that DISAGREES with the pin
 *     claude-fable-5                   passes every filter at DOUBLE the price — §3's whole point
 *     claude-opus-4-8                  the current pin; must survive the merge
 *     claude-haiku-4-5                 undated id…
 *     claude-haiku-4-5-20251001        …and its dated twin, which must be dropped
 *     claude-opus-4-1                  $15/$75 — the id an UNANCHORED `^claude-opus-` would elect
 *     claude-translate-2               `tool_call: false` → filtered out
 *     (broken)                         id missing / cost of the wrong type
 *   google
 *     gemini-3.1-pro-preview           newest `-pro` → wins the gemini family
 *     gemini-3-pro-preview             the current pin, older
 *     gemini-3.6-flash                 newest overall — proves the family regex, not the sort, decides
 *     gemini-3.1-pro-preview-customtools  matches `^gemini-` but not the anchored family
 *     gemini-flash-latest              ROLLING alias → excluded (`gemini.ts:311-315`)
 *     gemini-3-pro-image               image output → excluded
 *     gemini-robotics-er-1.6-preview   `-robotics` anywhere in the id → excluded
 *     gemini-2.5-computer-use-preview-10-2025  `-computer-use` in the MIDDLE → excluded
 *   openrouter
 *     anthropic/claude-opus-5          wins the opencode family
 *     anthropic/claude-opus-5-fast     `-fast` → excluded by the anchored family regex
 *     anthropic/claude-sonnet-5        allow-listed vendor, not in the family
 *                                      + input/output prices and NO cache prices — the
 *                                        Lot 11 case where a bucket contributes 0
 *     openai/gpt-5.5                   a second allow-listed vendor (drives the `<optgroup>` case)
 *     deepseek/deepseek-chat           the pinned opencode id, live-confirmed
 *     inception/mercury-coder          vendor NOT on the allowlist → excluded
 */

/** Not `unknown` on purpose: tests hand this straight to `deriveCatalogue`. */
export const MODELS_DEV_FIXTURE: Record<string, unknown> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-opus-5': {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        release_date: '2026-07-24',
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 200000, output: 64000 },
      },
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        release_date: '2026-06-29',
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        // A live window that DISAGREES with the pinned 200 000 for `claude-*`:
        // whichever of the two this fixture proves is used, it cannot be an
        // accident of both saying the same thing.
        limit: { context: 1000000, output: 64000 },
      },
      'claude-fable-5': {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        release_date: '2026-06-07',
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
      },
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        release_date: '2026-05-28',
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5 (latest)',
        release_date: '2025-10-15',
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
      },
      'claude-haiku-4-5-20251001': {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        release_date: '2025-10-15',
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
      },
      'claude-opus-4-1': {
        id: 'claude-opus-4-1',
        name: 'Claude Opus 4.1 (latest)',
        release_date: '2025-08-05',
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
      },
      // Synthetic, and the only synthetic id in the anthropic block: no shipped
      // claude model has `tool_call: false`, but an agent CLI cannot drive a
      // model that cannot call tools, so the filter has to be exercised.
      'claude-translate-2': {
        id: 'claude-translate-2',
        name: 'Claude Translate 2',
        release_date: '2026-07-01',
        tool_call: false,
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 1, output: 5 },
      },
      // ── deliberately broken, from here down ──────────────────────────────
      // No `id` field at all AND a key that is not a usable id. Must be
      // dropped on its own without taking the seven good entries with it.
      '': { name: 'Nameless', release_date: '2026-07-25', tool_call: true },
      // `cost` of the wrong type: the entry is still a valid model, so it must
      // survive — only its price tag disappears from the label.
      'claude-opus-5-priceless': {
        id: 'claude-opus-5-priceless',
        name: 'Claude Opus 5 (no price data)',
        release_date: '2020-01-01',
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        cost: 'free',
        // `limit.context: 0` — present but unusable. A zero denominator would
        // pin every gauge at 100 %, so it must be dropped like a missing one.
        limit: { context: 0 },
      },
    },
  },
  google: {
    id: 'google',
    name: 'Google',
    models: {
      'gemini-3.1-pro-preview': {
        id: 'gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro Preview',
        release_date: '2026-02-19',
        tool_call: true,
        modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text'] },
        cost: { input: 2, output: 12, cache_read: 0.2 },
      },
      'gemini-3-pro-preview': {
        id: 'gemini-3-pro-preview',
        name: 'Gemini 3 Pro Preview',
        release_date: '2025-11-18',
        tool_call: true,
        modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text'] },
        cost: { input: 2, output: 12, cache_read: 0.2 },
      },
      'gemini-3.6-flash': {
        id: 'gemini-3.6-flash',
        name: 'Gemini 3.6 Flash',
        release_date: '2026-07-21',
        tool_call: true,
        modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text'] },
        cost: { input: 1.5, output: 7.5, cache_read: 0.15 },
      },
      'gemini-3.1-pro-preview-customtools': {
        id: 'gemini-3.1-pro-preview-customtools',
        name: 'Gemini 3.1 Pro Preview Custom Tools',
        release_date: '2026-02-19',
        tool_call: true,
        modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text'] },
        cost: { input: 2, output: 12, cache_read: 0.2 },
      },
      'gemini-flash-latest': {
        id: 'gemini-flash-latest',
        name: 'Gemini Flash Latest',
        release_date: '2025-09-25',
        tool_call: true,
        modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text'] },
        cost: { input: 0.3, output: 2.5 },
      },
      'gemini-3-pro-image': {
        id: 'gemini-3-pro-image',
        name: 'Gemini 3 Pro Image',
        release_date: '2025-11-20',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['image', 'text'] },
        cost: { input: 2, output: 12 },
      },
      'gemini-robotics-er-1.6-preview': {
        id: 'gemini-robotics-er-1.6-preview',
        name: 'Gemini Robotics-ER 1.6 Preview',
        release_date: '2026-04-14',
        tool_call: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        cost: { input: 1, output: 5 },
      },
      'gemini-2.5-computer-use-preview-10-2025': {
        id: 'gemini-2.5-computer-use-preview-10-2025',
        name: 'Gemini 2.5 Computer Use Preview 10-2025',
        release_date: '2025-10-07',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 1.25, output: 10 },
      },
    },
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    models: {
      'anthropic/claude-opus-5': {
        id: 'anthropic/claude-opus-5',
        name: 'Claude Opus 5',
        release_date: '2026-07-24',
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      'anthropic/claude-opus-5-fast': {
        id: 'anthropic/claude-opus-5-fast',
        name: 'Claude Opus 5 Fast',
        release_date: '2026-07-24',
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        cost: { input: 7.5, output: 37.5 },
      },
      'anthropic/claude-sonnet-5': {
        id: 'anthropic/claude-sonnet-5',
        name: 'Claude Sonnet 5',
        release_date: '2026-06-29',
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        cost: { input: 2, output: 10 },
      },
      'openai/gpt-5.5': {
        id: 'openai/gpt-5.5',
        name: 'GPT-5.5',
        release_date: '2026-04-23',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 5, output: 20 },
      },
      'deepseek/deepseek-chat': {
        id: 'deepseek/deepseek-chat',
        name: 'DeepSeek Chat',
        release_date: '2025-12-01',
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0.2002, output: 0.8001 },
      },
      'inception/mercury-coder': {
        id: 'inception/mercury-coder',
        name: 'Mercury Coder',
        release_date: '2025-04-30',
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0.25, output: 1 },
      },
    },
  },
};

/**
 * A reduced slice of `~/.codex/models_cache.json` as written by codex CLI
 * 0.130.0 on this host — the five `visibility: "list"` ids plus the one hidden
 * entry, which is the whole reason the reader filters on visibility at all.
 *
 * `priority` (not a date — this payload has none) is the CLI's own ordering,
 * and therefore ours: `gpt-5.5` at 0 is what `codex` itself offers first.
 */
export const CODEX_CACHE_FIXTURE: Record<string, unknown> = {
  fetched_at: '2026-05-15T02:26:38.620553353Z',
  client_version: '0.130.0',
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 0 },
    { slug: 'gpt-5.4', display_name: 'gpt-5.4', visibility: 'list', priority: 2 },
    { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', priority: 4 },
    { slug: 'gpt-5.3-codex', display_name: 'gpt-5.3-codex', visibility: 'list', priority: 6 },
    { slug: 'gpt-5.2', display_name: 'gpt-5.2', visibility: 'list', priority: 10 },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      visibility: 'hide',
      priority: 29,
    },
    // Broken: no slug. Dropped alone, without costing us the five above.
    { display_name: 'Ghost', visibility: 'list', priority: 1 },
  ],
};
