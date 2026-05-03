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
  dmCallEnded,
  dmCallStarted,
  dmCallUserJoined,
  dmCallUserLeft,
  fetchDmChannels,
  removeDmChannel,
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
    subscribe('onDmMemberAdd', trpc.dms.onMemberAdd, () => fetchDmChannels()),
    subscribe('onDmMemberRemove', trpc.dms.onMemberRemove, () =>
      fetchDmChannels()
    )
  );
};

export { subscribeToDms };
