import {
  removeServerEntryByPublicId,
  saveFederatedServers
} from '@/features/app/actions';
import { subscribeToDms } from '@/features/dms/subscriptions';
import { subscribeToFriends } from '@/features/friends/subscriptions';
import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import { appSliceActions } from '../app/slice';
import { store } from '../store';
import { setPublicServerSettings } from './actions';
import { subscribeToCategories } from './categories/subscriptions';
import { subscribeToChannels } from './channels/subscriptions';
import { subscribeToEmojis } from './emojis/subscriptions';
import { subscribeToMessages } from './messages/subscriptions';
import { subscribeToPlugins } from './plugins/subscriptions';
import { subscribeToRoles } from './roles/subscriptions';
import { subscribeToUsers } from './users/subscriptions';
import { subscribeToVoice } from './voice/subscriptions';

const subscribeToServer = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe(
      'onSettingsUpdate',
      trpc.others.onServerSettingsUpdate,
      (settings) => {
        // Settings events only arrive for servers the user is a MEMBER of
        // (publishFor member ids) — while previewing, the slice holds a
        // DIFFERENT server's snapshot and must not be overwritten by them.
        if (!store.getState().server.previewMode) {
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
    ),
    subscribe('onServerMemberJoin', trpc.servers.onMemberJoin, ({ server }) =>
      store.dispatch(appSliceActions.addJoinedServer(server))
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
    subscribeToPlugins,
    subscribeToFriends,
    subscribeToDms
  ];

  const unsubscribes = subscriptors.map((subscriptor) => subscriptor());

  return () => {
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
};

export { initSubscriptions, subscribeToVoice };
