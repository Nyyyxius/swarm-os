/**
 * No-op `Notifier` for when `SWARM_OS_DISCORD_WEBHOOK_URL` is absent.
 *
 * Logs the event so a human inspecting `docker logs` still sees that the
 * notification was triggered, then returns. Same call sites as the Discord
 * impl — wiring code never has to branch on whether the webhook is set.
 */

import { withModule } from '../../logger.js';
import type { Notifier, NotificationInput, CustomNotificationInput } from './index.js';

const log = withModule('notify');

export class NoOpNotifier implements Notifier {
  muteUntil: number | undefined = undefined;

  async notify(input: NotificationInput): Promise<void> {
    if (this.muteUntil !== undefined && Date.now() < this.muteUntil) return;
    log.info({
      event: 'notify.noop',
      kind: input.kind,
      orchId: input.orchestrator.id,
      sessionId: input.session?.id,
      message: input.message,
    });
  }

  async notifyCustom(input: CustomNotificationInput): Promise<void> {
    if (this.muteUntil !== undefined && Date.now() < this.muteUntil) return;
    log.info({
      event: 'notify.noop.custom',
      plugin: input.pluginName,
      level: input.level,
      title: input.title,
      message: input.message,
    });
  }
}
