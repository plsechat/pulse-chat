import { getHomeTRPCClient } from '@/lib/trpc';
import type { TJoinedDmMessage, TVoiceUserState } from '@pulse/shared';
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
  updateDmMessage
} from './actions';

const subscribeToDms = () => {
  const trpc = getHomeTRPCClient();

  const onNewMessageSub = trpc.dms.onNewMessage.subscribe(undefined, {
    onData: async (message: TJoinedDmMessage) => {
      const decrypted = await decryptDmMessageInPlace(message);
      addDmMessages(decrypted.dmChannelId, [decrypted], {}, true);
    },
    onError: (err) =>
      console.error('onDmNewMessage subscription error:', err)
  });

  const onMessageUpdateSub = trpc.dms.onMessageUpdate.subscribe(undefined, {
    onData: async (message: TJoinedDmMessage) => {
      const decrypted = await decryptDmMessageInPlace(message);
      updateDmMessage(decrypted);

      // Notify pinned messages panel so it can refetch
      window.dispatchEvent(
        new CustomEvent('dm-pinned-messages-changed', {
          detail: { dmChannelId: decrypted.dmChannelId }
        })
      );
    },
    onError: (err) =>
      console.error('onDmMessageUpdate subscription error:', err)
  });

  const onMessageDeleteSub = trpc.dms.onMessageDelete.subscribe(undefined, {
    onData: ({
      dmMessageId,
      dmChannelId
    }: {
      dmMessageId: number;
      dmChannelId: number;
    }) => deleteDmMessage(dmChannelId, dmMessageId),
    onError: (err) =>
      console.error('onDmMessageDelete subscription error:', err)
  });

  const onCallStartedSub = trpc.dms.onCallStarted.subscribe(undefined, {
    onData: ({
      dmChannelId,
      startedBy
    }: {
      dmChannelId: number;
      startedBy: number;
    }) => dmCallStarted(dmChannelId, startedBy),
    onError: (err) =>
      console.error('onDmCallStarted subscription error:', err)
  });

  const onCallEndedSub = trpc.dms.onCallEnded.subscribe(undefined, {
    onData: ({ dmChannelId }: { dmChannelId: number }) =>
      dmCallEnded(dmChannelId),
    onError: (err) => console.error('onDmCallEnded subscription error:', err)
  });

  const onCallUserJoinedSub = trpc.dms.onCallUserJoined.subscribe(undefined, {
    onData: ({
      dmChannelId,
      userId,
      state
    }: {
      dmChannelId: number;
      userId: number;
      state: TVoiceUserState;
    }) => {
      dmCallUserJoined(dmChannelId, userId, state);
      addUserToVoiceChannel(userId, dmChannelId, state);
    },
    onError: (err) =>
      console.error('onDmCallUserJoined subscription error:', err)
  });

  const onTypingSub = trpc.dms.onTyping.subscribe(undefined, {
    onData: ({
      dmChannelId,
      userId
    }: {
      dmChannelId: number;
      userId: number;
    }) => addDmTypingUser(dmChannelId, userId),
    onError: (err) =>
      console.error('onDmTyping subscription error:', err)
  });

  const onCallUserLeftSub = trpc.dms.onCallUserLeft.subscribe(undefined, {
    onData: ({
      dmChannelId,
      userId
    }: {
      dmChannelId: number;
      userId: number;
    }) => {
      dmCallUserLeft(dmChannelId, userId);
      removeUserFromVoiceChannel(userId, dmChannelId);
    },
    onError: (err) =>
      console.error('onDmCallUserLeft subscription error:', err)
  });

  const onChannelUpdateSub = trpc.dms.onChannelUpdate.subscribe(undefined, {
    onData: () => fetchDmChannels(),
    onError: (err) =>
      console.error('onDmChannelUpdate subscription error:', err)
  });

  const onMemberAddSub = trpc.dms.onMemberAdd.subscribe(undefined, {
    onData: () => fetchDmChannels(),
    onError: (err) =>
      console.error('onDmMemberAdd subscription error:', err)
  });

  const onMemberRemoveSub = trpc.dms.onMemberRemove.subscribe(undefined, {
    onData: () => fetchDmChannels(),
    onError: (err) =>
      console.error('onDmMemberRemove subscription error:', err)
  });

  return () => {
    onNewMessageSub.unsubscribe();
    onMessageUpdateSub.unsubscribe();
    onMessageDeleteSub.unsubscribe();
    onTypingSub.unsubscribe();
    onCallStartedSub.unsubscribe();
    onCallEndedSub.unsubscribe();
    onCallUserJoinedSub.unsubscribe();
    onCallUserLeftSub.unsubscribe();
    onChannelUpdateSub.unsubscribe();
    onMemberAddSub.unsubscribe();
    onMemberRemoveSub.unsubscribe();
  };
};

export { subscribeToDms };
