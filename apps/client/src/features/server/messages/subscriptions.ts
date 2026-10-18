import { store } from '@/features/store';
import {
  combineUnsubscribes,
  subscribe,
  type Unsubscribe
} from '@/lib/subscription-helpers';
import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import {
  addMessages,
  addTypingUser,
  bulkDeleteMessages,
  deleteMessage,
  purgeChannelMessages,
  updateMessage
} from './actions';
import { decryptChannelMessageForDisplay } from './decrypt';
import { emitAppEvent } from '@/lib/events';
import { toast } from 'sonner';
import { failedCommandReply } from './command-reply';

/**
 * The encrypted channels the reset peer shares with us (empty for a
 * DM-only peer). A server predating the field broadcasts without it;
 * the handler then falls back to re-keying every encrypted channel it
 * is a member of.
 */
function readResetChannelIds(payload: {
  channelIds?: number[];
}): number[] | undefined {
  return Array.isArray(payload.channelIds) ? payload.channelIds : undefined;
}


const subscribeToMessages = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  // Single source of truth for the unsubscribe set. Previously this
  // file kept TWO copies of the unsub list (one for the early-return
  // path when getHomeTRPCClient returns null, one for the main path) —
  // adding a new subscription meant remembering to add it to both,
  // which is exactly the kind of footgun combineUnsubscribes exists
  // to prevent.
  const subs: Unsubscribe[] = [
    subscribe('onMessage', trpc.messages.onNew, async (message) => {
      const decrypted = await decryptChannelMessageForDisplay(message);
      addMessages(decrypted.channelId, [decrypted], {}, true);
    }),
    subscribe('onMessageUpdate', trpc.messages.onUpdate, async (message) => {
      const decrypted = await decryptChannelMessageForDisplay(message);
      updateMessage(decrypted.channelId, decrypted);
      // Your own command came back refused: say why, not only on the card.
      if (message.userId === store.getState().server.ownUserId) {
        const reply = failedCommandReply(message.content);
        if (reply) toast.error(reply);
      }
    }),
    // A server predating tombstones sends no deletedAt/deletedBy; the
    // row is then marked as deleted now, by nobody.
    subscribe(
      'onMessageDelete',
      trpc.messages.onDelete,
      ({ messageId, channelId, deletedAt, deletedBy }) =>
        deleteMessage(channelId, messageId, {
          deletedAt: deletedAt ?? Date.now(),
          deletedBy: deletedBy ?? null
        })
    ),
    subscribe(
      'onMessageBulkDelete',
      trpc.messages.onBulkDelete,
      ({ messageIds, channelId, purged, deletedAt, deletedBy }) => {
        if (purged) {
          purgeChannelMessages(channelId);
        } else {
          bulkDeleteMessages(channelId, messageIds, {
            deletedAt: deletedAt ?? Date.now(),
            deletedBy: deletedBy ?? null
          });
        }
      }
    ),
    subscribe(
      'onMessageTyping',
      trpc.messages.onTyping,
      ({ userId, channelId }) => addTypingUser(channelId, userId)
    ),
    subscribe('onMessagePin', trpc.messages.onPin, ({ channelId }) =>
      emitAppEvent('pinned-messages-changed', { channelId })
    ),
    subscribe('onMessageUnpin', trpc.messages.onUnpin, ({ channelId }) =>
      emitAppEvent('pinned-messages-changed', { channelId })
    ),
    subscribe(
      'onSenderKeyDistribution',
      trpc.e2ee.onSenderKeyDistribution,
      async ({ channelId, fromUserId }) => {
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
      }
    ),
    subscribe('onInviteCreate', trpc.invites.onInviteCreate, () =>
      emitAppEvent('invites-changed')
    ),
    subscribe('onInviteDelete', trpc.invites.onInviteDelete, () =>
      emitAppEvent('invites-changed')
    ),
    subscribe('onNoteUpdate', trpc.notes.onNoteUpdate, ({ targetUserId }) =>
      emitAppEvent('notes-changed', { targetUserId })
    ),
    subscribe('onThreadCreate', trpc.threads.onThreadCreate, () =>
      emitAppEvent('threads-changed')
    ),
    subscribe('onThreadUpdate', trpc.threads.onThreadUpdate, () =>
      emitAppEvent('threads-changed')
    ),
    subscribe('onThreadDelete', trpc.threads.onThreadDelete, () =>
      emitAppEvent('threads-changed')
    ),
    subscribe('onPollUpdate', trpc.polls.onUpdate, (update) =>
      emitAppEvent('poll-updated', update)
    ),
    subscribe('onScheduledPostUpdate', trpc.scheduled.onUpdate, ({ channelId }) =>
      emitAppEvent('scheduled-posts-changed', { channelId })
    ),
    subscribe('onChannelFollowsUpdate', trpc.follows.onUpdate, ({ channelId }) =>
      emitAppEvent('channel-follows-changed', { channelId })
    )
  ];

  // Identity resets are handled on the instance they arrive from: the
  // ids in the payload are that instance's, and so are the store the
  // peer's pin and session live in and the channels to re-key. Home
  // ids come over the home socket (subscribeToHome, alive for the whole
  // home connection); host-local ids come over the active federated
  // socket, subscribed here.
  const homeTrpc = getHomeTRPCClient();
  const activeDomain = store.getState().app.activeInstanceDomain;
  if (activeDomain && trpc !== homeTrpc) {
    subs.push(
      subscribe(
        'onFederatedIdentityReset',
        trpc.e2ee.onIdentityReset,
        async (payload) => {
          try {
            const { getFederatedE2eeInstance, handlePeerIdentityReset } =
              await import('@/lib/e2ee');
            const instance = await getFederatedE2eeInstance(activeDomain);
            if (!instance) return;
            await handlePeerIdentityReset(payload.userId, instance, {
              newIdentityPublicKey: payload.newIdentityPublicKey,
              channelIds: readResetChannelIds(payload)
            });
          } catch (err) {
            console.error(
              `[E2EE] Failed to handle identity reset for user ${payload.userId} on ${activeDomain}:`,
              err
            );
          }
        }
      )
    );
  }

  return combineUnsubscribes(...subs);
};

export { subscribeToMessages };
