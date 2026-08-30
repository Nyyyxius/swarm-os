/**
 * Discord webhook implementation of the `Notifier` interface (plan §12).
 *
 * Embed shape:
 *
 *   - Title varies by kind (with a leading emoji glyph for at-a-glance triage).
 *   - Color: 0xFFFF00 (waiting), 0xFF6666 (ended bad), 0x00CC66 (ended ok),
 *     0xFF0000 (anomaly). Colors are encoded as decimal in the JSON per
 *     Discord's webhook contract.
 *   - Fields: Project, Orchestrator, Session (when applicable), Status.
 *   - URL: deep-link to the orchestrator UI page **only** if `publicUrl` is
 *     set. Never includes any token (plan §12, §14). The user authenticates
 *     in their browser when they land on the page.
 *   - Description: `input.message`.
 *   - Timestamp: ISO of the event.
 *
 * Reliability:
 *
 *   - Bounded by `DEFAULT_TIMEOUT_MS` (5 s).
 *   - On any failure (HTTP non-2xx, network error, abort) we log a warning
 *     and return — the orchestrator must NEVER block on notifications.
 *   - No retries / no coalescing in MVP (plan §12).
 */

import { withModule } from '../../logger.js';
import type {
  Notifier,
  NotificationInput,
  NotificationKind,
  NotificationLevel,
  CustomNotificationInput,
} from './index.js';

const log = withModule('notify');

const DEFAULT_TIMEOUT_MS = 5000;

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  url?: string;
  timestamp?: string;
}

interface DiscordPayload {
  embeds: DiscordEmbed[];
}

const COLORS: Record<NotificationKind, number> = {
  'session.waiting': 0xffff00, // yellow
  'session.approval_requested': 0xff9900, // amber — a human decision is pending
  'orchestrator.ended': 0xff6666, // soft red — overridden to green for clean exits
  'session.exit_anomaly': 0xff0000, // red
  'session.budget_exceeded': 0xff0000, // red — money already spent, possibly paused
};

const TITLES: Record<NotificationKind, string> = {
  'session.waiting': 'Session waiting for attention',
  'session.approval_requested': 'Approval requested',
  'orchestrator.ended': 'Orchestrator ended',
  'session.exit_anomaly': 'Session exit anomaly',
  'session.budget_exceeded': 'Cost budget exceeded',
};

const TITLE_GLYPHS: Record<NotificationKind, string> = {
  'session.waiting': '[WAIT]',
  'session.approval_requested': '[APPROVE?]',
  'orchestrator.ended': '[END]',
  'session.exit_anomaly': '[FAIL]',
  'session.budget_exceeded': '[BUDGET]',
};

/**
 * Operator instruction rendered on an `session.approval_requested` embed. P3 is
 * INFORMATIONAL only — a webhook embed cannot carry buttons, and Discord reply
 * routing is P4. So we tell the operator exactly where the actionable controls
 * live: the web toast/page (Approve / Deny / open the console), which is the
 * key P3 deliverable. Kept in French to match the operator-facing Discord copy.
 */
const APPROVAL_INSTRUCTION =
  'Approuve/Refuse depuis le web (page ou toast), ou ouvre la console de la session.';

/**
 * Colors for plugin custom notifications (`notifyCustom`) — same palette as
 * the built-in kinds: green (clean/OK), yellow (attention), red (anomaly).
 */
const LEVEL_COLORS: Record<NotificationLevel, number> = {
  info: 0x00cc66, // green
  warn: 0xffff00, // yellow
  critical: 0xff0000, // red
};

/** Discord caps embed titles at 256 chars. */
const EMBED_TITLE_MAX = 256;
/** Consistent with `buildPayload` — descriptions are truncated to 4000. */
const EMBED_DESCRIPTION_MAX = 4000;

export interface DiscordWebhookNotifierOptions {
  webhookUrl: string;
  projectName: string;
  /** When set, the embed gets a clickable URL pointing at this orch's UI page. */
  publicUrl?: string | null;
  /** Override for tests. */
  timeoutMs?: number;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class DiscordWebhookNotifier implements Notifier {
  private readonly webhookUrl: string;
  private readonly projectName: string;
  private readonly publicUrl: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DiscordWebhookNotifierOptions) {
    this.webhookUrl = opts.webhookUrl;
    this.projectName = opts.projectName;
    this.publicUrl = opts.publicUrl ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Build the embed payload for a notification. Public so tests + the
   * verify script can call it without going through the network.
   */
  buildPayload(input: NotificationInput): DiscordPayload {
    const kind = input.kind;
    const orch = input.orchestrator;
    const session = input.session;

    // Color resolution: orchestrator.ended is bicolor — green for `stopped`
    // (clean), soft-red for `failed` (crash). Other kinds use the static map.
    let color = COLORS[kind];
    if (kind === 'orchestrator.ended' && orch.status === 'stopped') {
      color = 0x00cc66; // green
    }

    const fields: DiscordEmbedField[] = [
      { name: 'Project', value: this.projectName, inline: true },
      { name: 'Orchestrator', value: `${orch.name} (${orch.role})`, inline: true },
    ];
    if (session) {
      fields.push({
        name: 'Session',
        value: `${session.name} (${session.role}, ${session.type})`,
        inline: true,
      });
    }
    fields.push({ name: 'Status', value: session?.status ?? orch.status, inline: true });

    if (input.extra?.exitCode != null) {
      fields.push({ name: 'Exit code', value: String(input.extra.exitCode), inline: true });
    } else if (session?.exitCode != null) {
      fields.push({ name: 'Exit code', value: String(session.exitCode), inline: true });
    }
    if (input.extra?.stopReason != null) {
      fields.push({ name: 'Stop reason', value: String(input.extra.stopReason), inline: true });
    } else if (session?.stopReason) {
      fields.push({ name: 'Stop reason', value: session.stopReason, inline: true });
    }

    // Approval-gate enrichment (P3): name WHAT is being asked and, since this
    // embed has no buttons, spell out how to answer. `extra.category` is the
    // best-effort permission/question class from the store; the instruction
    // field is a NON-inline full-width row so it reads as a call to action.
    if (kind === 'session.approval_requested') {
      if (input.extra?.category != null) {
        fields.push({ name: 'Category', value: String(input.extra.category), inline: true });
      }
      fields.push({ name: 'Action', value: APPROVAL_INSTRUCTION, inline: false });
    }

    // Budget enrichment (Lot 14): the two numbers that justify the alert, and
    // what the server did about it. `costUsd` is a LOWER BOUND — anything the
    // rate card could not price counts as 0 — so the embed says `>=` rather
    // than pretending to an exact bill.
    if (kind === 'session.budget_exceeded') {
      if (input.extra?.costUsd != null) {
        fields.push({ name: 'Spent', value: `>= $${String(input.extra.costUsd)}`, inline: true });
      }
      if (input.extra?.budgetUsd != null) {
        fields.push({ name: 'Budget', value: `$${String(input.extra.budgetUsd)}`, inline: true });
      }
      if (input.extra?.action != null) {
        fields.push({
          name: 'Outcome',
          value:
            input.extra.action === 'pause'
              ? 'PAUSE — every session of the team was suspended (lead included). Resume by hand.'
              : 'NOTIFY — the team keeps running.',
          inline: false,
        });
      }
    }

    const embed: DiscordEmbed = {
      title: `${TITLE_GLYPHS[kind]} ${TITLES[kind]}`,
      description: truncate(input.message ?? '', EMBED_DESCRIPTION_MAX),
      color,
      fields,
      timestamp: new Date().toISOString(),
    };

    if (this.publicUrl) {
      // Deep-link to the orchestrator detail page (matches the SPA hash
      // routing). NEVER carries any token — the user authenticates in the
      // browser via the Settings panel.
      const base = this.publicUrl.replace(/\/+$/, '');
      embed.url = `${base}/#/orchestrators/${encodeURIComponent(orch.id)}`;
    }

    return { embeds: [embed] };
  }

  /**
   * Build the embed payload for a plugin custom notification
   * (`api.notify.custom`). Public for the same reason as `buildPayload` —
   * tests assert the embed shape without going through the network. The
   * `[plugin:<name>]` prefix comes from `input.pluginName`, injected by the
   * plugin façade (the caller never controls it). No deep-link URL: a custom
   * notification carries no orchestrator to point at.
   */
  buildCustomPayload(input: CustomNotificationInput): DiscordPayload {
    const embed: DiscordEmbed = {
      title: truncate(`[plugin:${input.pluginName}] ${input.title}`, EMBED_TITLE_MAX),
      description: truncate(input.message, EMBED_DESCRIPTION_MAX),
      color: LEVEL_COLORS[input.level],
      fields: [
        { name: 'Project', value: this.projectName, inline: true },
        { name: 'Plugin', value: input.pluginName, inline: true },
        { name: 'Level', value: input.level, inline: true },
      ],
      timestamp: new Date().toISOString(),
    };
    return { embeds: [embed] };
  }

  /**
   * Phase 8 — mute window. When set to a future epoch ms, notify() returns
   * immediately. Used by the boot sequence to dampen the post-resume storm.
   */
  muteUntil: number | undefined = undefined;

  async notify(input: NotificationInput): Promise<void> {
    if (this.muteUntil !== undefined && Date.now() < this.muteUntil) {
      log.info({
        event: 'notify.discord.muted',
        kind: input.kind,
        orchId: input.orchestrator.id,
        sessionId: input.session?.id,
        remainsMs: this.muteUntil - Date.now(),
      });
      return;
    }
    await this.deliver(this.buildPayload(input), {
      kind: input.kind,
      orchId: input.orchestrator.id,
      sessionId: input.session?.id,
    });
  }

  async notifyCustom(input: CustomNotificationInput): Promise<void> {
    if (this.muteUntil !== undefined && Date.now() < this.muteUntil) {
      log.info({
        event: 'notify.discord.muted',
        plugin: input.pluginName,
        level: input.level,
        remainsMs: this.muteUntil - Date.now(),
      });
      return;
    }
    await this.deliver(this.buildCustomPayload(input), {
      plugin: input.pluginName,
      level: input.level,
    });
  }

  /**
   * POST a payload to the webhook — timeout-bounded, never throws. Shared by
   * `notify()` and `notifyCustom()`; `logCtx` is spread into every log line.
   */
  private async deliver(payload: DiscordPayload, logCtx: Record<string, unknown>): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      if (!res.ok) {
        // 429 (rate-limit) and 5xx are both treated as transient warnings.
        // No retry in MVP — plan §12 prefers losing a notif over blocking.
        log.warn({
          event: 'notify.discord.bad_status',
          status: res.status,
          ...logCtx,
        });
        return;
      }
      log.info({
        event: 'notify.discord.sent',
        ...logCtx,
      });
    } catch (err) {
      log.warn({
        event: 'notify.discord.failed',
        ...logCtx,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
