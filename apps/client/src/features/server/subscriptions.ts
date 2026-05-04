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
      (settings) => setPublicServerSettings(settings)
    ),
    subscribe('onServerMemberJoin', trpc.servers.onMemberJoin, ({ server }) =>
      store.dispatch(appSliceActions.addJoinedServer(server))
    ),
    subscribe(
      'onServerMemberLeave',
      trpc.servers.onMemberLeave,
      ({ serverId }) =>
        store.dispatch(appSliceActions.removeJoinedServer(serverId))
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
