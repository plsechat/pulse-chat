/**
 * SKDM-arrival auto-retry.
 *
 * When an SKDM is finally accepted for (channelId, fromUserId) — either
 * via the live subscription handler or via fetchAndProcessPending* —
 * any messages from that sender that arrived BEFORE the SKDM and got
 * stuck on the "[Unable to decrypt]" placeholder are now decryptable.
 * This module finds those stuck messages in Redux and re-runs the
 * decrypt-and-update path. Best-effort: a still-failing message stays
 * "[Unable to decrypt]" so the next SKDM event has another chance.
 *
 * Exists because the old bounded-retry-inside-decrypt approach gave
 * up after ~3.5s. With this module the SKDM acts as the "now retry"
 * signal instead of a wall-clock timer.
 */

import { decryptChannelMessageForDisplay } from '@/features/server/messages/decrypt';
import { updateMessage as updateChannelMessage } from '@/features/server/messages/actions';
import { decryptDmMessageInPlace, updateDmMessage } from '@/features/dms/actions';
import { store as reduxStore } from '@/features/store';

const FAILED_PLACEHOLDER = '[Unable to decrypt]';

export async function retryFailedChannelDecrypts(
  channelId: number,
  fromUserId: number
): Promise<void> {
  const state = reduxStore.getState();
  const messages = state.server.messagesMap[channelId];
  if (!messages || messages.length === 0) return;

  const stuck = messages.filter(
    (m) =>
      m.userId === fromUserId &&
      m.e2ee &&
      m.content === FAILED_PLACEHOLDER
  );
  if (stuck.length === 0) return;

  for (const msg of stuck) {
    try {
      const decrypted = await decryptChannelMessageForDisplay(msg);
      if (decrypted.content !== FAILED_PLACEHOLDER) {
        updateChannelMessage(channelId, decrypted);
      }
    } catch (err) {
      console.warn(
        `[E2EE] Retry-decrypt channel msg ${msg.id} from user ${fromUserId} still failing:`,
        err
      );
    }
  }
}

export async function retryFailedDmDecrypts(
  dmChannelId: number,
  fromUserId: number
): Promise<void> {
  const state = reduxStore.getState();
  const messages = state.dms.messagesMap[dmChannelId];
  if (!messages || messages.length === 0) return;

  const stuck = messages.filter(
    (m) =>
      m.userId === fromUserId &&
      m.e2ee &&
      m.content === FAILED_PLACEHOLDER
  );
  if (stuck.length === 0) return;

  for (const msg of stuck) {
    try {
      const decrypted = await decryptDmMessageInPlace(msg);
      if (decrypted.content !== FAILED_PLACEHOLDER) {
        updateDmMessage(decrypted);
      }
    } catch (err) {
      console.warn(
        `[E2EE/DM] Retry-decrypt msg ${msg.id} from user ${fromUserId} still failing:`,
        err
      );
    }
  }
}
