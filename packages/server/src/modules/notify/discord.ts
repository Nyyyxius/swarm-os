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
import type { Notifier, NotificationInput, NotificationKind } from './index.js';

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
  'orchestrator.ended': 0xff6666, // soft red — overridden to green for clean exits
  'session.exit_anomaly': 0xff0000, // red
};

const TITLES: Record<NotificationKind, string> = {
  'session.waiting': 'Session waiting for attention',
  'orchestrator.ended': 'Orchestrator ended',
  'session.exit_anomaly': 'Session exit anomaly',
};

const TITLE_GLYPHS: Record<NotificationKind, string> = {
  'session.waiting': '[WAIT]',
  'orchestrator.ended': '[END]',
  'session.exit_anomaly': '[FAIL]',
};

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

    const embed: DiscordEmbed = {
      title: `${TITLE_GLYPHS[kind]} ${TITLES[kind]}`,
      description: truncate(input.message ?? '', 4000),
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
    const payload = this.buildPayload(input);
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
          kind: input.kind,
          status: res.status,
          orchId: input.orchestrator.id,
          sessionId: input.session?.id,
        });
        return;
      }
      log.info({
        event: 'notify.discord.sent',
        kind: input.kind,
        orchId: input.orchestrator.id,
        sessionId: input.session?.id,
      });
    } catch (err) {
      log.warn({
        event: 'notify.discord.failed',
        kind: input.kind,
        orchId: input.orchestrator.id,
        sessionId: input.session?.id,
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
