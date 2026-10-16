import {
  cleanupFederatedServerEntry,
  leaveServerContext,
  removeServerEntryByPublicId,
  saveFederatedServers
} from '@/features/app/actions';
import { subscribeToDms } from '@/features/dms/subscriptions';
import { subscribeToFriends } from '@/features/friends/subscriptions';
import { connectionManager } from '@/lib/connection-manager';
import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import { toast } from 'sonner';
import { appSliceActions } from '../app/slice';
import { store } from '../store';
import { setPublicServerSettings } from './actions';
import { subscribeToCategories } from './categories/subscriptions';
import { subscribeToChannels } from './channels/subscriptions';
import { subscribeToEmojis } from './emojis/subscriptions';
import { subscribeToMessages } from './messages/subscriptions';
import { subscribeToPlugins } from './plugins/subscriptions';
import { subscribeToRoles } from './roles/subscriptions';
import { handleUserJoin } from './users/actions';
import { subscribeToUsers } from './users/subscriptions';
import { subscribeToVoice } from './voice/subscriptions';

/**
 * The encrypted channels the reset peer shares with us (empty for a
 * DM-only peer). A server predating the field broadcasts without it;
 * the handler then falls back to re-keying every encrypted channel it
 * is a member of.
 */
const readResetChannelIds = (payload: {
  channelIds?: number[];
}): number[] | undefined =>
  Array.isArray(payload.channelIds) ? payload.channelIds : undefined;

/**
 * Instance-scoped server events: bound to the ACTIVE instance's client
 * and re-created on every server switch (initSubscriptions).
 */
const subscribeToServer = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe(
      'onSettingsUpdate',
      trpc.others.onServerSettingsUpdate,
      (settings) => {
        // Settings events arrive for EVERY server the user is a member
        // of (publishFor member ids). The slice holds one server's
        // settings — the one in focus (matched by publicId; a preview
        // holds a different server's snapshot and never matches) — so
        // an edit on another server must only touch the rail below.
        const current = store.getState().server;
        if (!current.previewMode && current.serverId === settings.publicId) {
          setPublicServerSettings(settings);
        }

        // Live-sync the server rail (name/logo used to stay stale until a
        // full refresh). Matched by publicId — home and federated entries.
        if (settings?.publicId) {
          store.dispatch(
            appSliceActions.updateJoinedServerInfo({
              publicId: settings.publicId,
              name: settings.name,
              logo: settings.logo
            })
          );

          const fed = store
            .getState()
            .app.federatedServers.find(
              (e) => e.server.publicId === settings.publicId
            );
          if (fed) {
            store.dispatch(
              appSliceActions.updateFederatedServerInfo({
                instanceDomain: fed.instanceDomain,
                serverId: fed.server.id,
                server: {
                  ...fed.server,
                  name: settings.name,
                  ...(settings.logo !== undefined
                    ? { logo: settings.logo }
                    : {})
                }
              })
            );
            saveFederatedServers();
          }
        }
      }
    )
  );
};

/**
 * Home-scoped events that feed the server rail and the federation
 * bookkeeping. Always bound to the HOME client and created once per
 * home connection (connect), never per server switch: bound to the
 * active instance, a remote server's unread events landed in the home
 * map under the remote's numeric id (a phantom badge on whichever home
 * server shares it), a remote member-join pushed a remote summary into
 * the home rail, and the home servers' own badges stopped updating for
 * as long as a federated server was in focus. The remote instances'
 * unread feeds are the federated map subscriptions in app/actions.
 */
const subscribeToHomeServerEvents = () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    // Fanned out to every member of the server. Our own join (from
    // this or another device) adds the server to the rail; someone
    // else's adds them to the roster when we are viewing that server.
    // An older server publishes it to the joiner only, without `user`.
    subscribe(
      'onServerMemberJoin',
      trpc.servers.onMemberJoin,
      ({ serverId, serverPublicId, userId, server, user }) => {
        if (userId === store.getState().app.homeOwnUserId) {
          store.dispatch(appSliceActions.addJoinedServer(server));
          return;
        }
        if (user) handleUserJoin(serverId, user, serverPublicId);
      }
    ),
    subscribe(
      'onServerMemberLeave',
      trpc.servers.onMemberLeave,
      ({ serverId, serverPublicId }) => {
        // Match by the globally-unique publicId when present — the numeric
        // id alone can collide with a federated server's id and would drop
        // the wrong joined-list entry. Numeric fallback for older servers.
        if (serverPublicId !== undefined) {
          removeServerEntryByPublicId(serverPublicId);
        } else {
          store.dispatch(appSliceActions.removeJoinedServer(serverId));
        }
      }
    ),
    subscribe('onUnreadCountUpdate', trpc.servers.onUnreadCountUpdate, (data) =>
      store.dispatch(
        appSliceActions.setServerUnreadCount({
          serverId: data.serverId,
          count: data.count,
          mentionCount: data.mentionCount
        })
      )
    )
  );
};

/**
 * Home-scoped federation events. Identity resets for home ids (DM
 * peers, home channels, and federated peers' rotations relayed to our
 * home as shadow ids) come over the home socket; the active instance's
 * own resets are handled in messages/subscriptions.
 */
const subscribeToHomeFederationEvents = () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onIdentityReset', trpc.e2ee.onIdentityReset, async (payload) => {
      try {
        const { getHomeE2eeInstance, handlePeerIdentityReset } = await import(
          '@/lib/e2ee'
        );
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
    }),
    subscribe(
      'onFederationInstanceUpdate',
      trpc.federation.onInstanceUpdate,
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
          leaveServerContext();
        }
      }
    ),
    // A federated peer kicked or banned us from one of its servers —
    // the peer told our home instance, which delivers this user-scoped
    // event. Drop the rail entry and surface the reason.
    subscribe(
      'onFederatedServerRemoved',
      trpc.federation.onServerRemoved,
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
          leaveServerContext();
        }

        // Full local cleanup — including instance-connection teardown
        // when this was the last server on that instance. A ban means
        // every reconnect would be refused; without the teardown the
        // connection manager retries forever and the status badge
        // flickers connecting/disconnected.
        cleanupFederatedServerEntry(entry.instanceDomain, entry.server.id);
      }
    )
  );
};

/**
 * Everything that follows the HOME connection rather than the server in
 * focus. Created once in connect() and torn down only on disconnect or
 * when the socket is replaced.
 */
const subscribeToHome = () => {
  const subscriptors = [
    subscribeToHomeServerEvents,
    subscribeToHomeFederationEvents,
    subscribeToFriends,
    subscribeToDms
  ];

  return combineUnsubscribes(
    ...subscriptors.map((subscriptor) => subscriptor())
  );
};

/**
 * Everything scoped to the server in focus: bound to the active
 * instance's client and re-created on every server switch.
 */
const initSubscriptions = () => {
  // Voice subscriptions are intentionally NOT included here.
  // They persist across server switches and are managed separately
  // in actions.ts to prevent audio disruption during server navigation.
  const subscriptors = [
    subscribeToChannels,
    subscribeToServer,
    subscribeToEmojis,
    subscribeToRoles,
    subscribeToUsers,
    subscribeToMessages,
    subscribeToCategories,
    subscribeToPlugins
  ];

  return combineUnsubscribes(
    ...subscriptors.map((subscriptor) => subscriptor())
  );
};

export { initSubscriptions, subscribeToHome, subscribeToVoice };
