import { connectionManager } from '@/lib/connection-manager';
import {
  fetchAndProcessPendingDmSenderKeys,
  processIncomingFederatedSenderKey
} from '@/lib/e2ee';
import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getHomeTRPCClient } from '@/lib/trpc';
import {
  addUserToVoiceChannel,
  removeUserFromVoiceChannel
} from '../server/voice/actions';
import {
  addDmMessages,
  addDmTypingUser,
  decryptDmMessageInPlace,
  deleteDmMessage,
  dmCallDeclined,
  dmCallEnded,
  dmCallStarted,
  dmCallUserJoined,
  dmCallUserLeft,
  fetchDmChannels,
  removeDmChannel,
  syncDmGroupSenderKeysOnMemberAdd,
  syncDmGroupSenderKeysOnMemberRemove,
  updateDmMessage
} from './actions';

const subscribeToDms = () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onDmNewMessage', trpc.dms.onNewMessage, async (message) => {
      const decrypted = await decryptDmMessageInPlace(message);
      addDmMessages(decrypted.dmChannelId, [decrypted], {}, true);
    }),
    subscribe('onDmMessageUpdate', trpc.dms.onMessageUpdate, async (message) => {
      const decrypted = await decryptDmMessageInPlace(message);
      updateDmMessage(decrypted);
      // Notify pinned messages panel so it can refetch
      window.dispatchEvent(
        new CustomEvent('dm-pinned-messages-changed', {
          detail: { dmChannelId: decrypted.dmChannelId }
        })
      );
    }),
    subscribe(
      'onDmMessageDelete',
      trpc.dms.onMessageDelete,
      ({ dmMessageId, dmChannelId }) => deleteDmMessage(dmChannelId, dmMessageId)
    ),
    subscribe(
      'onDmCallStarted',
      trpc.dms.onCallStarted,
      ({ dmChannelId, startedBy }) => dmCallStarted(dmChannelId, startedBy)
    ),
    subscribe('onDmCallEnded', trpc.dms.onCallEnded, ({ dmChannelId }) =>
      dmCallEnded(dmChannelId)
    ),
    subscribe(
      'onDmCallUserJoined',
      trpc.dms.onCallUserJoined,
      ({ dmChannelId, userId, state }) => {
        dmCallUserJoined(dmChannelId, userId, state);
        addUserToVoiceChannel(userId, dmChannelId, state);
      }
    ),
    subscribe('onDmTyping', trpc.dms.onTyping, ({ dmChannelId, userId }) =>
      addDmTypingUser(dmChannelId, userId)
    ),
    subscribe(
      'onDmCallUserLeft',
      trpc.dms.onCallUserLeft,
      ({ dmChannelId, userId }) => {
        dmCallUserLeft(dmChannelId, userId);
        removeUserFromVoiceChannel(userId, dmChannelId);
      }
    ),
    subscribe(
      'onDmCallDeclined',
      trpc.dms.onCallDeclined,
      ({ dmChannelId, userId }) => dmCallDeclined(dmChannelId, userId)
    ),
    subscribe('onDmChannelUpdate', trpc.dms.onChannelUpdate, () =>
      fetchDmChannels()
    ),
    subscribe(
      'onDmChannelDelete',
      trpc.dms.onChannelDelete,
      (data) => {
        const { dmChannelId } = data as { dmChannelId: number };
        removeDmChannel(dmChannelId);
      }
    ),
    subscribe('onDmMemberAdd', trpc.dms.onMemberAdd, async (data) => {
      const { dmChannelId, userId } = data as {
        dmChannelId: number;
        userId: number;
      };
      await fetchDmChannels();
      // If we already have a sender key for this DM (it's encrypted),
      // distribute it to the new joiner.
      await syncDmGroupSenderKeysOnMemberAdd(dmChannelId, userId);
    }),
    subscribe('onDmMemberRemove', trpc.dms.onMemberRemove, async (data) => {
      const { dmChannelId, userId } = data as {
        dmChannelId: number;
        userId: number;
      };
      await fetchDmChannels();
      // Forward secrecy: rotate our sender key so the leaver can't
      // decrypt new messages with the cached old key. If we *are* the
      // leaver, do nothing — we're out of the channel.
      await syncDmGroupSenderKeysOnMemberRemove(dmChannelId, userId);
    }),
    subscribe(
      'onDmSenderKeyDistribution',
      trpc.dms.onSenderKeyDistribution,
      async ({ dmChannelId }) => {
        try {
          await fetchAndProcessPendingDmSenderKeys(dmChannelId);
        } catch (err) {
          console.error(
            '[E2EE/DM] Failed to process pending sender keys:',
            err
          );
        }
      }
    ),
    // Phase E / E1f — federated channel SKDM available on a host.
    // Fired on home WS when one of our local users is a recipient of
    // a fresh SKDM stored on a peer instance. We open or reuse the
    // active-server tRPC to that host, fetch all pending SKDMs (the
    // notification is a wake-up; the actual rows tell us what's
    // there), decrypt each via the federated path, and ack on host.
    subscribe(
      'onFederatedSenderKeyAvailable',
      trpc.e2ee.onFederatedSenderKeyAvailable,
      async ({ hostDomain }) => {
        try {
          const hostTrpc =
            connectionManager.getRemoteTRPCClient(hostDomain);
          if (!hostTrpc) {
            console.warn(
              '[E2EE] no active connection to %s for federated SKDM',
              hostDomain
            );
            return;
          }

          const pending = await hostTrpc.e2ee.getPendingSenderKeys.query({});
          if (pending.length === 0) return;

          const processedIds: number[] = [];
          for (const row of pending) {
            try {
              if (!row.fromHomePublicId) {
                // Sender record on host has no usable publicId —
                // can't be addressed cross-instance. Skip; the row
                // will get re-fetched if anything changes.
                continue;
              }
              await processIncomingFederatedSenderKey({
                hostDomain,
                hostChannelId: row.channelId,
                hostFromUserId: row.fromUserId,
                fromHomePublicId: row.fromHomePublicId,
                fromInstanceDomain: row.fromInstanceDomain,
                distributionMessage: row.distributionMessage
              });
              processedIds.push(row.id);
            } catch (err) {
              console.warn(
                '[E2EE] Failed to process federated SKDM row:',
                err
              );
            }
          }

          if (processedIds.length > 0) {
            try {
              await hostTrpc.e2ee.acknowledgeSenderKeys.mutate({
                ids: processedIds
              });
            } catch {
              // Non-fatal: rows persist and get retried next time.
            }
          }
        } catch (err) {
          console.error(
            '[E2EE] Federated SKDM-available handler failed:',
            err
          );
        }
      }
    )
  );
};

export { subscribeToDms };
