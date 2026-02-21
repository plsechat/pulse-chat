import { subscribeToDms } from '@/features/dms/subscriptions';
import { subscribeToFriends } from '@/features/friends/subscriptions';
import { getTRPCClient } from '@/lib/trpc';
import type { TPublicServerSettings, TServerSummary } from '@pulse/shared';
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

  const onSettingsUpdateSub = trpc.others.onServerSettingsUpdate.subscribe(
    undefined,
    {
      onData: (settings: TPublicServerSettings) =>
        setPublicServerSettings(settings),
      onError: (err) =>
        console.error('onSettingsUpdate subscription error:', err)
    }
  );

  const onMemberJoinSub = trpc.servers.onMemberJoin.subscribe(undefined, {
    onData: ({
      server
    }: {
      serverId: number;
      userId: number;
      server: TServerSummary;
    }) => {
      store.dispatch(appSliceActions.addJoinedServer(server));
    },
    onError: (err) =>
      console.error('onServerMemberJoin subscription error:', err)
  });

  const onMemberLeaveSub = trpc.servers.onMemberLeave.subscribe(undefined, {
    onData: ({ serverId }: { serverId: number; userId: number }) => {
      store.dispatch(appSliceActions.removeJoinedServer(serverId));
    },
    onError: (err) =>
      console.error('onServerMemberLeave subscription error:', err)
  });

  const onUnreadCountUpdateSub =
    trpc.servers.onUnreadCountUpdate.subscribe(undefined, {
      onData: (data: { serverId: number; count: number; mentionCount: number }) => {
        store.dispatch(
          appSliceActions.setServerUnreadCount({
            serverId: data.serverId,
            count: data.count,
            mentionCount: data.mentionCount
          })
        );
      },
      onError: (err) =>
        console.error('onUnreadCountUpdate subscription error:', err)
    });

  return () => {
    onSettingsUpdateSub.unsubscribe();
    onMemberJoinSub.unsubscribe();
    onMemberLeaveSub.unsubscribe();
    onUnreadCountUpdateSub.unsubscribe();
  };
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
