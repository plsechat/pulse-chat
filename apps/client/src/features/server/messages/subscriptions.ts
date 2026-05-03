import { saveFederatedServers, setActiveView } from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { store } from '@/features/store';
import { connectionManager } from '@/lib/connection-manager';
import { decryptChannelMessage } from '@/lib/e2ee';
import { setFileKeys } from '@/lib/e2ee/file-key-store';
import {
  combineUnsubscribes,
  subscribe,
  type Unsubscribe
} from '@/lib/subscription-helpers';
import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import type { TJoinedMessage } from '@pulse/shared';
import {
  addMessages,
  addTypingUser,
  bulkDeleteMessages,
  deleteMessage,
  purgeChannelMessages,
  updateMessage
} from './actions';

async function decryptReplyToContent(
  replyTo: NonNullable<TJoinedMessage['replyTo']>,
  channelId: number
): Promise<NonNullable<TJoinedMessage['replyTo']>> {
  if (!replyTo.e2ee || !replyTo.content) return replyTo;
  try {
    const payload = await decryptChannelMessage(
      channelId,
      replyTo.userId,
      replyTo.content
    );
    return { ...replyTo, content: payload.content };
  } catch {
    return { ...replyTo, content: '[Unable to decrypt]' };
  }
}

async function decryptE2eeMessage(
  message: TJoinedMessage
): Promise<TJoinedMessage> {
  // Always pass the replyTo through the decryptor when present —
  // server returns ciphertext for e2ee parents, and unlike DMs the
  // channel sender-key scheme is idempotent so this is cheap.
  const replyTo = message.replyTo
    ? await decryptReplyToContent(message.replyTo, message.channelId)
    : message.replyTo;

  if (!message.e2ee || !message.content) {
    return replyTo === message.replyTo ? message : { ...message, replyTo };
  }

  try {
    const payload = await decryptChannelMessage(
      message.channelId,
      message.userId,
      message.content
    );
    setFileKeys(message.id, payload.fileKeys);
    return { ...message, content: payload.content, replyTo };
  } catch (err) {
    console.error('[E2EE] Failed to decrypt channel message:', err);
    return { ...message, content: '[Unable to decrypt]', replyTo };
  }
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
      const decrypted = await decryptE2eeMessage(message);
      addMessages(decrypted.channelId, [decrypted], {}, true);
    }),
    subscribe('onMessageUpdate', trpc.messages.onUpdate, async (message) => {
      const decrypted = await decryptE2eeMessage(message);
      updateMessage(decrypted.channelId, decrypted);
    }),
    subscribe(
      'onMessageDelete',
      trpc.messages.onDelete,
      ({ messageId, channelId }) => deleteMessage(channelId, messageId)
    ),
    subscribe(
      'onMessageBulkDelete',
      trpc.messages.onBulkDelete,
      ({ messageIds, channelId, purged }) => {
        if (purged) {
          purgeChannelMessages(channelId);
        } else {
          bulkDeleteMessages(channelId, messageIds);
        }
      }
    ),
    subscribe(
      'onMessageTyping',
      trpc.messages.onTyping,
      ({ userId, channelId }) => addTypingUser(channelId, userId)
    ),
    subscribe('onMessagePin', trpc.messages.onPin, ({ channelId }) =>
      window.dispatchEvent(
        new CustomEvent('pinned-messages-changed', { detail: { channelId } })
      )
    ),
    subscribe('onMessageUnpin', trpc.messages.onUnpin, ({ channelId }) =>
      window.dispatchEvent(
        new CustomEvent('pinned-messages-changed', { detail: { channelId } })
      )
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
    subscribe(
      'onIdentityReset',
      trpc.e2ee.onIdentityReset,
      async ({ userId }) => {
        try {
          const { handlePeerIdentityReset } = await import('@/lib/e2ee');
          await handlePeerIdentityReset(userId);
        } catch (err) {
          console.error(
            `[E2EE] Failed to handle identity reset for user ${userId}:`,
            err
          );
        }
      }
    ),
    subscribe('onInviteCreate', trpc.invites.onInviteCreate, () =>
      window.dispatchEvent(new CustomEvent('invites-changed'))
    ),
    subscribe('onInviteDelete', trpc.invites.onInviteDelete, () =>
      window.dispatchEvent(new CustomEvent('invites-changed'))
    ),
    subscribe('onNoteUpdate', trpc.notes.onNoteUpdate, ({ targetUserId }) =>
      window.dispatchEvent(
        new CustomEvent('notes-changed', { detail: { targetUserId } })
      )
    ),
    subscribe('onThreadCreate', trpc.threads.onThreadCreate, () =>
      window.dispatchEvent(new CustomEvent('threads-changed'))
    ),
    subscribe('onThreadUpdate', trpc.threads.onThreadUpdate, () =>
      window.dispatchEvent(new CustomEvent('threads-changed'))
    ),
    subscribe('onThreadDelete', trpc.threads.onThreadDelete, () =>
      window.dispatchEvent(new CustomEvent('threads-changed'))
    )
  ];

  // Federation instance updates are home-scoped — only mount when we
  // have a home tRPC client. The conditional push keeps the unsub set
  // a single list, no early-return required.
  const homeTrpc = getHomeTRPCClient();
  if (homeTrpc) {
    subs.push(
      subscribe(
        'onFederationInstanceUpdate',
        homeTrpc.federation.onInstanceUpdate,
        (event) => {
          if (
            (event.status !== 'removed' && event.status !== 'blocked') ||
            !event.domain
          ) {
            return;
          }
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
            setActiveView('home');
          }
        }
      )
    );
  }

  return combineUnsubscribes(...subs);
};

export { subscribeToMessages };
