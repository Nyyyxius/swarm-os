/**
 * Approval-gate — post the "approval requested" notification to Discord
 * (docs/garde-fous-approbation.md §6 "Poster l'approbation via le notifier
 * par-orch et mémoriser l'id du message Discord posté").
 *
 * TWO channels, chosen per-orch:
 *
 *  1. **Bot (preferred, P4-capable).** When the orch's role carries a Discord
 *     BOT (`botToken` + `channelId`) and the bot is live, we post via the bot's
 *     `sendMessage`, which RETURNS the posted message id. We persist that id on
 *     the approval (`store.setDiscordMessageId`) so a native *reply* to this
 *     message can later be routed straight back to this approval (P4,
 *     `bot.handleMessageCreate`). The bot is also the thing that receives those
 *     replies, so posting through it keeps the message in exactly the channel the
 *     bot listens on.
 *
 *  2. **Webhook (fallback, P3 informational).** When there is no bot (webhook-
 *     only role) we fall back to the per-orch webhook embed from P3 via
 *     `orch.notifier`. No message id is captured and no reply routing is possible
 *     — which is correct: without a bot listening on the channel, a reply could
 *     not be observed anyway.
 *
 * Best-effort throughout: this runs on the `/hooks/notification` path, which must
 * never throw (spike H6). The caller already wraps the call, and every branch
 * here swallows its own errors.
 */

import { withModule } from '../../logger.js';
import { isDiscordConnector } from '../roles/index.js';
import type { Spawner } from '../spawner/index.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Session } from '../orchestrator/session.js';
import type { ApprovalRequest, ApprovalStore } from './store.js';

const log = withModule('approvals.discord');

/** Discord hard-caps a message at 2000 chars — keep a margin. */
const MAX_DISCORD_LEN = 1900;

/**
 * Build the plain-text bot message. Names WHAT is requested and spells out how to
 * answer — since a bot message has no buttons, the reply-text protocol (P4) plus
 * the web/console fallbacks are the actionable controls. FR to match the
 * operator-facing Discord copy.
 */
function buildApprovalText(orch: Orchestrator, session: Session, approval: ApprovalRequest): string {
  const summary = approval.requestedSummary || `${session.name} needs approval`;
  const lines = [
    `🔐 **Approbation requise** — ${orch.name} :: ${session.name}`,
    summary,
    '',
    'Réponds **à ce message** : ✅ `oui`/`approve` ou ❌ `non`/`deny` ' +
      '(ajoute « ne plus demander » pour ne plus être sollicité pour cette session). ' +
      'Ou décide depuis le web (toast/page) ou ouvre la console.',
  ];
  const text = lines.join('\n');
  return text.length > MAX_DISCORD_LEN ? text.slice(0, MAX_DISCORD_LEN - 1) + '…' : text;
}

/**
 * Post the approval notification for `approval`. Prefers the bot (captures +
 * persists the message id for P4 reply routing); falls back to the P3 webhook
 * embed. Never throws.
 */
export async function notifyApprovalRequested(args: {
  spawner: Spawner;
  orch: Orchestrator;
  session: Session;
  approval: ApprovalRequest;
  store: ApprovalStore;
}): Promise<void> {
  const { spawner, orch, session, approval, store } = args;

  // ---- P5: plugin channel connector (e.g. `discord-agent`) ------------------
  // When the orch's role carries a NON-builtin connector whose provider exposes
  // the optional `sendToOrchChannel` seam, post the approval THROUGH the plugin
  // and capture the returned message id (same reply-routing contract as the
  // built-in bot). This is the path for deployments that serve Discord via a
  // plugin instead of the integrated bot — there `orch.notifier` is a no-op and
  // the bot pool has no bot for this orch, so without this branch nothing is
  // posted. Tried FIRST; on success we return (never a double post). Absent or
  // failing → fall through to the built-in bot, then the webhook. Never throws.
  try {
    const role = orch.roleId && spawner.roleStore ? spawner.roleStore.get(orch.roleId) : null;
    const registry = spawner.connectorRegistry;
    if (role && registry) {
      for (const connector of role.connectors) {
        if (connector.type === 'discord') continue; // built-in → handled below
        const provider = registry.get(connector.type);
        if (!provider?.sendToOrchChannel) continue;
        const text = buildApprovalText(orch, session, approval);
        const res = await provider.sendToOrchChannel(orch.id, text);
        if (res?.messageId) {
          const persisted = store.setDiscordMessageId(approval.id, res.messageId);
          log.info({
            event: 'approvals.discord_posted_via_plugin',
            orchId: orch.id,
            sessionId: session.id,
            approvalId: approval.id,
            connectorType: connector.type,
            discordMessageId: res.messageId,
            persisted,
          });
          return;
        }
      }
    }
  } catch (err) {
    // Plugin post failed — fall through to the bot / webhook so the operator
    // still sees something. The approval hook must never throw (spike H6).
    log.warn({
      event: 'approvals.discord_plugin_post_failed',
      orchId: orch.id,
      approvalId: approval.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- Preferred (native): post via the bot to capture the message id -------
  try {
    const bot = spawner.discordBotPool?.botForOrch(orch.id) ?? null;
    const role = orch.roleId && spawner.roleStore ? spawner.roleStore.get(orch.roleId) : null;
    const channelId = role?.connectors.find(isDiscordConnector)?.channelId;
    if (bot && bot.isReady() && channelId) {
      const text = buildApprovalText(orch, session, approval);
      const { messageId } = await bot.sendMessage(channelId, text);
      const persisted = store.setDiscordMessageId(approval.id, messageId);
      log.info({
        event: 'approvals.discord_posted',
        orchId: orch.id,
        sessionId: session.id,
        approvalId: approval.id,
        discordMessageId: messageId,
        persisted,
      });
      return;
    }
  } catch (err) {
    // Bot post failed — fall through to the webhook so the operator still sees
    // *something* (just without reply routing).
    log.warn({
      event: 'approvals.discord_bot_post_failed',
      orchId: orch.id,
      approvalId: approval.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- Fallback: the P3 per-orch webhook embed (informational only) ---------
  try {
    await orch.notifier.notify({
      kind: 'session.approval_requested',
      orchestrator: { id: orch.id, name: orch.name, role: orch.role, status: orch.status },
      session: {
        id: session.id,
        name: session.name,
        role: session.role,
        type: session.type,
        status: session.status,
        exitCode: session.exitCode,
        stopReason: session.stopReason,
      },
      message: approval.requestedSummary,
      extra: { approvalId: approval.id, category: approval.category },
    });
  } catch (err) {
    log.warn({
      event: 'approvals.discord_webhook_failed',
      orchId: orch.id,
      approvalId: approval.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
