import { decryptChannelMessage } from '@/lib/e2ee';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedMessage } from '@pulse/shared';
import {
  addMessages,
  addTypingUser,
  deleteMessage,
  updateMessage
} from './actions';

async function decryptE2eeMessage(
  message: TJoinedMessage
): Promise<TJoinedMessage> {
  if (!message.e2ee || !message.encryptedContent) return message;

  try {
    const payload = await decryptChannelMessage(
      message.channelId,
      message.userId,
      message.encryptedContent
    );
    return { ...message, content: payload.content };
  } catch (err) {
    console.error('[E2EE] Failed to decrypt channel message:', err);
    return { ...message, content: '[Unable to decrypt]' };
  }
}

const subscribeToMessages = () => {
  const trpc = getTRPCClient();

  const onMessageSub = trpc.messages.onNew.subscribe(undefined, {
    onData: async (message: TJoinedMessage) => {
      const decrypted = await decryptE2eeMessage(message);
      addMessages(decrypted.channelId, [decrypted], {}, true);
    },
    onError: (err) => console.error('onMessage subscription error:', err)
  });

  const onMessageUpdateSub = trpc.messages.onUpdate.subscribe(undefined, {
    onData: async (message: TJoinedMessage) => {
      const decrypted = await decryptE2eeMessage(message);
      updateMessage(decrypted.channelId, decrypted);
    },
    onError: (err) => console.error('onMessageUpdate subscription error:', err)
  });

  const onMessageDeleteSub = trpc.messages.onDelete.subscribe(undefined, {
    onData: ({ messageId, channelId }) => deleteMessage(channelId, messageId),
    onError: (err) => console.error('onMessageDelete subscription error:', err)
  });

  const onMessageTypingSub = trpc.messages.onTyping.subscribe(undefined, {
    onData: ({ userId, channelId }) => {
      addTypingUser(channelId, userId);
    },
    onError: (err) => console.error('onMessageTyping subscription error:', err)
  });

  const onMessagePinSub = trpc.messages.onPin.subscribe(undefined, {
    onData: ({
      channelId
    }: {
      messageId: number;
      channelId: number;
      pinnedBy: number;
    }) => {
      window.dispatchEvent(
        new CustomEvent('pinned-messages-changed', { detail: { channelId } })
      );
    },
    onError: (err) => console.error('onMessagePin subscription error:', err)
  });

  const onMessageUnpinSub = trpc.messages.onUnpin.subscribe(undefined, {
    onData: ({
      channelId
    }: {
      messageId: number;
      channelId: number;
    }) => {
      window.dispatchEvent(
        new CustomEvent('pinned-messages-changed', { detail: { channelId } })
      );
    },
    onError: (err) => console.error('onMessageUnpin subscription error:', err)
  });

  // Subscribe to sender key distributions for channel E2EE
  const onSenderKeyDistSub = trpc.e2ee.onSenderKeyDistribution.subscribe(
    undefined,
    {
      onData: async ({
        channelId,
        fromUserId
      }: {
        channelId: number;
        fromUserId: number;
      }) => {
        try {
          const { fetchAndProcessPendingSenderKeys } = await import(
            '@/lib/e2ee'
          );
          await fetchAndProcessPendingSenderKeys(channelId);
        } catch (err) {
          console.error(
            `[E2EE] Failed to process sender key from user ${fromUserId}:`,
            err
          );
        }
      },
      onError: (err) =>
        console.error('onSenderKeyDistribution subscription error:', err)
    }
  );

  // Subscribe to E2EE identity resets (key regeneration broadcasts)
  const onIdentityResetSub = trpc.e2ee.onIdentityReset.subscribe(undefined, {
    onData: async ({ userId }: { userId: number }) => {
      try {
        const { handlePeerIdentityReset } = await import('@/lib/e2ee');
        await handlePeerIdentityReset(userId);
      } catch (err) {
        console.error(
          `[E2EE] Failed to handle identity reset for user ${userId}:`,
          err
        );
      }
    },
    onError: (err) =>
      console.error('onIdentityReset subscription error:', err)
  });

  return () => {
    onMessageSub.unsubscribe();
    onMessageUpdateSub.unsubscribe();
    onMessageDeleteSub.unsubscribe();
    onMessageTypingSub.unsubscribe();
    onMessagePinSub.unsubscribe();
    onMessageUnpinSub.unsubscribe();
    onSenderKeyDistSub.unsubscribe();
    onIdentityResetSub.unsubscribe();
  };
};

export { subscribeToMessages };
