import {
  cleanupFederatedServerEntry,
  saveFederatedServers,
  setActiveView
} from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { store } from '@/features/store';
import { connectionManager } from '@/lib/connection-manager';
import {
  combineUnsubscribes,
  subscribe,
  type Unsubscribe
} from '@/lib/subscription-helpers';
import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import { toast } from 'sonner';
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
    )
  ];

  // Identity resets are handled on the instance they arrive from: the
  // ids in the payload are that instance's, and so are the store the
  // peer's pin and session live in and the channels to re-key. Home
  // ids (DM peers, home channels, and federated peers' rotations
  // relayed to our home as shadow ids) come over the home socket —
  // subscribed here even while a federated server is in focus, which
  // used to drop them. Host-local ids come over the active federated
  // socket.
  const homeTrpc = getHomeTRPCClient();
  const activeDomain = store.getState().app.activeInstanceDomain;
  if (homeTrpc) {
    subs.push(
      subscribe(
        'onIdentityReset',
        homeTrpc.e2ee.onIdentityReset,
        async (payload) => {
          try {
            const { getHomeE2eeInstance, handlePeerIdentityReset } =
              await import('@/lib/e2ee');
            const instance = await getHomeE2eeInstance();
            if (!instance) return;
            await handlePeerIdentityReset(payload.userId, instance, {
              newIdentityPublicKey: payload.newIdentityPublicKey,
              channelIds: readResetChannelIds(payload)
            });
          } catch (err) {
            console.error(
              `[E2EE] Failed to handle identity reset for user ${payload.userId}:`,
              err
            );
          }
        }
      )
    );
  }
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

  // Federation instance updates are home-scoped — only mount when we
  // have a home tRPC client. The conditional push keeps the unsub set
  // a single list, no early-return required.
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

    // A federated peer kicked or banned us from one of its servers —
    // the peer told our home instance, which delivers this user-scoped
    // event. Drop the rail entry and surface the reason.
    subs.push(
      subscribe(
        'onFederatedServerRemoved',
        homeTrpc.federation.onServerRemoved,
        (event) => {
          const state = store.getState();
          const entry = state.app.federatedServers.find(
            (e) =>
              e.instanceDomain === event.instanceDomain &&
              e.server.publicId === event.serverPublicId
          );

          const displayName =
            event.serverName ?? entry?.server.name ?? event.instanceDomain;
          const reasonSuffix = event.reason ? `: ${event.reason}` : '';
          toast.error(
            event.action === 'ban'
              ? `You have been banned from ${displayName}${reasonSuffix}`
              : `You have been kicked from ${displayName}${reasonSuffix}`
          );

          if (!entry) return;

          // If we're currently viewing that server, go home FIRST — the
          // teardown below fires the disconnect status handler, which
          // would otherwise also toast "Lost connection" for the
          // still-active instance.
          if (
            state.app.activeInstanceDomain === event.instanceDomain &&
            state.server.serverId === event.serverPublicId
          ) {
            store.dispatch(appSliceActions.setActiveInstanceDomain(null));
            setActiveView('home');
          }

          // Full local cleanup — including instance-connection teardown
          // when this was the last server on that instance. A ban means
          // every reconnect would be refused; without the teardown the
          // connection manager retries forever and the status badge
          // flickers connecting/disconnected.
          cleanupFederatedServerEntry(
            entry.instanceDomain,
            entry.server.id
          );
        }
      )
    );
  }

  return combineUnsubscribes(...subs);
};

export { subscribeToMessages };
