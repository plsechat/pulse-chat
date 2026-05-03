import { setActiveView } from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { updateFriend } from '@/features/friends/actions';
import { resetServerState } from '@/features/server/actions';
import { store } from '@/features/store';
import { distributeSenderKeysToOnlineMember } from '@/lib/e2ee';
import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import { UserStatus } from '@pulse/shared';
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

  return combineUnsubscribes(
    subscribe('onUserJoin', trpc.users.onJoin, (payload) => {
      handleUserJoin(payload.serverId, payload.user);
      updateFriend(payload.user.id, payload.user);

      // Fire-and-forget: distribute sender keys to the newly online user
      distributeE2eeKeysToUser(payload.user.id).catch((err) =>
        console.warn('[E2EE] Proactive key distribution error:', err)
      );
    }),
    subscribe('onUserCreate', trpc.users.onCreate, (user) => addUser(user)),
    subscribe('onUserLeave', trpc.users.onLeave, (userId) => {
      updateUser(userId, { status: UserStatus.OFFLINE });
      updateFriend(userId, { status: UserStatus.OFFLINE });
    }),
    subscribe('onUserUpdate', trpc.users.onUpdate, (user) => {
      updateUser(user.id, user);
      updateFriend(user.id, user);
    }),
    subscribe('onUserDelete', trpc.users.onDelete, ({ serverId, userId }) => {
      // Server-scoped delete (kick/ban/leave from `serverId`). Only mutate
      // the local roster when we're actually viewing that server, otherwise
      // we'd corrupt the active server's user list (audit H1, same shape as
      // the USER_JOIN scope fix).
      const activeServerId = store.getState().app.activeServerId;
      if (serverId !== activeServerId) return;
      removeUser(userId);
    }),
    subscribe('onKicked', trpc.users.onKicked, ({ serverId, reason }) => {
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
    })
  );
};

export { subscribeToUsers };
