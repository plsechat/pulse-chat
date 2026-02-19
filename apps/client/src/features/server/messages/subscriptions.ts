import { saveFederatedServers } from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { store } from '@/features/store';
import { connectionManager } from '@/lib/connection-manager';
import { decryptChannelMessage } from '@/lib/e2ee';
import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import type { TJoinedMessage, TThreadInfo } from '@pulse/shared';
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

  // Invite subscriptions
  const onInviteCreateSub = trpc.invites.onInviteCreate.subscribe(undefined, {
    onData: () => {
      window.dispatchEvent(new CustomEvent('invites-changed'));
    },
    onError: (err) => console.error('onInviteCreate subscription error:', err)
  });

  const onInviteDeleteSub = trpc.invites.onInviteDelete.subscribe(undefined, {
    onData: () => {
      window.dispatchEvent(new CustomEvent('invites-changed'));
    },
    onError: (err) => console.error('onInviteDelete subscription error:', err)
  });

  // Note subscriptions
  const onNoteUpdateSub = trpc.notes.onNoteUpdate.subscribe(undefined, {
    onData: ({ targetUserId }: { targetUserId: number }) => {
      window.dispatchEvent(
        new CustomEvent('notes-changed', { detail: { targetUserId } })
      );
    },
    onError: (err) => console.error('onNoteUpdate subscription error:', err)
  });

  // Thread subscriptions
  const onThreadCreateSub = trpc.threads.onThreadCreate.subscribe(undefined, {
    onData: (_thread: TThreadInfo) => {
      window.dispatchEvent(new CustomEvent('threads-changed'));
    },
    onError: (err) => console.error('onThreadCreate subscription error:', err)
  });

  const onThreadUpdateSub = trpc.threads.onThreadUpdate.subscribe(undefined, {
    onData: (_thread: TThreadInfo) => {
      window.dispatchEvent(new CustomEvent('threads-changed'));
    },
    onError: (err) => console.error('onThreadUpdate subscription error:', err)
  });

  const onThreadDeleteSub = trpc.threads.onThreadDelete.subscribe(undefined, {
    onData: (_threadId: number) => {
      window.dispatchEvent(new CustomEvent('threads-changed'));
    },
    onError: (err) => console.error('onThreadDelete subscription error:', err)
  });

  // Subscribe to federation instance updates for real-time cleanup
  const homeTrpc = getHomeTRPCClient();
  const onFederationInstanceUpdateSub =
    homeTrpc.federation.onInstanceUpdate.subscribe(undefined, {
      onData: (event: { status: string; domain?: string }) => {
        if (
          (event.status === 'removed' || event.status === 'blocked') &&
          event.domain
        ) {
          const state = store.getState();
          const entries = state.app.federatedServers.filter(
            (s) => s.instanceDomain === event.domain
          );

          if (entries.length === 0) return;

          for (const entry of entries) {
            store.dispatch(
              appSliceActions.removeFederatedServer({
                instanceDomain: entry.instanceDomain,
                serverId: entry.server.id
              })
            );
          }

          saveFederatedServers();
          connectionManager.disconnectRemote(event.domain);

          // If user was viewing a removed federated server, reset to home
          if (state.app.activeInstanceDomain === event.domain) {
            store.dispatch(appSliceActions.setActiveInstanceDomain(null));
            store.dispatch(appSliceActions.setActiveView('home'));
          }
        }
      },
      onError: (err) =>
        console.error('onFederationInstanceUpdate subscription error:', err)
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
    onThreadCreateSub.unsubscribe();
    onThreadUpdateSub.unsubscribe();
    onThreadDeleteSub.unsubscribe();
    onInviteCreateSub.unsubscribe();
    onInviteDeleteSub.unsubscribe();
    onNoteUpdateSub.unsubscribe();
    onFederationInstanceUpdateSub.unsubscribe();
  };
};

export { subscribeToMessages };
