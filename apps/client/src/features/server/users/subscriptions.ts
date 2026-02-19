import { store } from '@/features/store';
import { getTRPCClient } from '@/lib/trpc';
import { UserStatus, type TJoinedPublicUser } from '@pulse/shared';
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

  const memberIds = state.server.users.map((u) => u.id);

  const { ensureChannelSenderKey, clearDistributedMember } = await import(
    '@/lib/e2ee'
  );

  // Clear the user from distributedMembers so we don't skip them.
  // If their identity changed (key reset), ensureSession with
  // verifyIdentity: true will detect the mismatch and rebuild.
  clearDistributedMember(joinedUserId);

  for (const channel of e2eeChannels) {
    try {
      await ensureChannelSenderKey(channel.id, ownUserId, memberIds);
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

  return () => {
    onUserJoinSub.unsubscribe();
    onUserLeaveSub.unsubscribe();
    onUserUpdateSub.unsubscribe();
    onUserCreateSub.unsubscribe();
    onUserDeleteSub.unsubscribe();
  };
};

export { subscribeToUsers };
