import { setActiveView } from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { updateFriend } from '@/features/friends/actions';
import { resetServerState } from '@/features/server/actions';
import { store } from '@/features/store';
import { distributeSenderKeysToOnlineMember } from '@/lib/e2ee';
import { getTRPCClient } from '@/lib/trpc';
import { UserStatus, type TJoinedPublicUser } from '@pulse/shared';
import { toast } from 'sonner';
import { addUser, handleUserJoin, removeUser, updateUser } from './actions';

/**
 * Snapshot the inputs needed by lib/e2ee from Redux. Keeping the lookup
 * here (rather than inside lib/e2ee) avoids a Redux dependency in the
 * E2EE module — `lib/` stays orchestrator-callable from anywhere.
 */
function distributeE2eeKeysToUser(joinedUserId: number): Promise<void> {
  const state = store.getState();
  const ownUserId = state.server.ownUserId;
  if (!ownUserId) return Promise.resolve();
  const e2eeChannelIds = state.server.channels
    .filter((c) => c.e2ee)
    .map((c) => c.id);
  return distributeSenderKeysToOnlineMember(
    joinedUserId,
    ownUserId,
    e2eeChannelIds
  );
}

const subscribeToUsers = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  const onUserJoinSub = trpc.users.onJoin.subscribe(undefined, {
    onData: (payload: { serverId: number; user: TJoinedPublicUser }) => {
      handleUserJoin(payload.serverId, payload.user);
      updateFriend(payload.user.id, payload.user);

      // Fire-and-forget: distribute sender keys to the newly online user
      distributeE2eeKeysToUser(payload.user.id).catch((err) =>
        console.warn('[E2EE] Proactive key distribution error:', err)
      );
    },
    onError: (err) => console.error('onUserJoin subscription error:', err)
  });

  const onUserCreateSub = trpc.users.onCreate.subscribe(undefined, {
    onData: (user: TJoinedPublicUser) => {
      addUser(user);
    },
    onError: (err) => console.error('onUserCreate subscription error:', err)
  });

  const onUserLeaveSub = trpc.users.onLeave.subscribe(undefined, {
    onData: (userId: number) => {
      updateUser(userId, { status: UserStatus.OFFLINE });
      updateFriend(userId, { status: UserStatus.OFFLINE });
    },
    onError: (err) => console.error('onUserLeave subscription error:', err)
  });

  const onUserUpdateSub = trpc.users.onUpdate.subscribe(undefined, {
    onData: (user: TJoinedPublicUser) => {
      updateUser(user.id, user);
      updateFriend(user.id, user);
    },
    onError: (err) => console.error('onUserUpdate subscription error:', err)
  });

  const onUserDeleteSub = trpc.users.onDelete.subscribe(undefined, {
    onData: ({ serverId, userId }: { serverId: number; userId: number }) => {
      // Server-scoped delete (kick/ban/leave from `serverId`). Only mutate
      // the local roster when we're actually viewing that server, otherwise
      // we'd corrupt the active server's user list (audit H1, same shape as
      // the USER_JOIN scope fix).
      const activeServerId = store.getState().app.activeServerId;
      if (serverId !== activeServerId) return;
      removeUser(userId);
    },
    onError: (err) => console.error('onUserDelete subscription error:', err)
  });

  const onKickedSub = trpc.users.onKicked.subscribe(undefined, {
    onData: ({ serverId, reason }: { serverId: number; reason?: string }) => {
      toast.error(
        reason
          ? `You have been kicked: ${reason}`
          : 'You have been kicked from the server'
      );

      // Remove the server from the joined list
      store.dispatch(appSliceActions.removeJoinedServer(serverId));

      // If we're currently viewing the kicked server, navigate to home
      const state = store.getState();
      if (state.app.activeServerId === serverId) {
        resetServerState();
        setActiveView('home');
        store.dispatch(appSliceActions.setActiveServerId(undefined));
      }
    },
    onError: (err) => console.error('onKicked subscription error:', err)
  });

  return () => {
    onUserJoinSub.unsubscribe();
    onUserLeaveSub.unsubscribe();
    onUserUpdateSub.unsubscribe();
    onUserCreateSub.unsubscribe();
    onUserDeleteSub.unsubscribe();
    onKickedSub.unsubscribe();
  };
};

export { subscribeToUsers };
