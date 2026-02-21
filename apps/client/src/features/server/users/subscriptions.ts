import { setActiveView } from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { resetServerState } from '@/features/server/actions';
import { store } from '@/features/store';
import { getTRPCClient } from '@/lib/trpc';
import { UserStatus, type TJoinedPublicUser } from '@pulse/shared';
import { toast } from 'sonner';
import { addUser, handleUserJoin, removeUser, updateUser } from './actions';

/**
 * When a user comes online, proactively distribute our sender keys to them
 * for every E2EE channel in the server. This closes the gap between
 * "member joins/reconnects" and "first message send" so the new user can
 * decrypt messages immediately.
 */
async function distributeE2eeKeysToUser(joinedUserId: number): Promise<void> {
  const state = store.getState();
  const ownUserId = state.server.ownUserId;
  if (!ownUserId || joinedUserId === ownUserId) return;

  const e2eeChannels = state.server.channels.filter((c) => c.e2ee);
  if (e2eeChannels.length === 0) return;

  const { ensureChannelSenderKey, clearDistributedMember } = await import(
    '@/lib/e2ee'
  );

  // Clear the user from distributedMembers so we don't skip them.
  // If their identity changed (key reset), ensureSession with
  // verifyIdentity: true will detect the mismatch and rebuild.
  clearDistributedMember(joinedUserId);

  for (const channel of e2eeChannels) {
    try {
      await ensureChannelSenderKey(channel.id, ownUserId);
    } catch (err) {
      console.warn(
        `[E2EE] Proactive key distribution failed for channel ${channel.id}:`,
        err
      );
    }
  }
}

const subscribeToUsers = () => {
  const trpc = getTRPCClient();

  const onUserJoinSub = trpc.users.onJoin.subscribe(undefined, {
    onData: (user: TJoinedPublicUser) => {
      handleUserJoin(user);

      // Fire-and-forget: distribute sender keys to the newly online user
      distributeE2eeKeysToUser(user.id).catch((err) =>
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
    },
    onError: (err) => console.error('onUserLeave subscription error:', err)
  });

  const onUserUpdateSub = trpc.users.onUpdate.subscribe(undefined, {
    onData: (user: TJoinedPublicUser) => {
      updateUser(user.id, user);
    },
    onError: (err) => console.error('onUserUpdate subscription error:', err)
  });

  const onUserDeleteSub = trpc.users.onDelete.subscribe(undefined, {
    onData: (userId: number) => {
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
