import {
  removeServerEntryByPublicId,
  setActiveInstanceDomain,
  setActiveView
} from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { dmsSliceActions } from '@/features/dms/slice';
import { updateFriend } from '@/features/friends/actions';
import { resetServerState } from '@/features/server/actions';
import { store } from '@/features/store';
import {
  distributeSenderKeysToOnlineMember,
  markChainForRotation
} from '@/lib/e2ee';
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
      handleUserJoin(payload.serverId, payload.user, payload.serverPublicId);
      updateFriend(payload.user.id, payload.user);
      store.dispatch(
        dmsSliceActions.updateMemberPresence({
          userId: payload.user.id,
          status: payload.user.status
        })
      );

      // Fire-and-forget: distribute sender keys to the newly online user
      distributeE2eeKeysToUser(payload.user.id).catch((err) =>
        console.warn('[E2EE] Proactive key distribution error:', err)
      );
    }),
    subscribe('onUserCreate', trpc.users.onCreate, (user) => addUser(user)),
    subscribe('onUserLeave', trpc.users.onLeave, (userId) => {
      updateUser(userId, { status: UserStatus.OFFLINE });
      updateFriend(userId, { status: UserStatus.OFFLINE });
      store.dispatch(
        dmsSliceActions.updateMemberPresence({
          userId,
          status: UserStatus.OFFLINE
        })
      );
    }),
    subscribe('onUserUpdate', trpc.users.onUpdate, (user) => {
      updateUser(user.id, user);
      updateFriend(user.id, user);
      // Only mirror presence when the event actually carries a status —
      // profile-only USER_UPDATEs omit the field and must not wipe it.
      if (user.status !== undefined) {
        store.dispatch(
          dmsSliceActions.updateMemberPresence({
            userId: user.id,
            status: user.status
          })
        );
      }
    }),
    subscribe(
      'onUserDelete',
      trpc.users.onDelete,
      ({ serverId, serverPublicId, userId }) => {
        // Server-scoped delete (kick/ban/leave from `serverId`). Only mutate
        // the local roster when we're actually viewing that server, otherwise
        // we'd corrupt the active server's user list (audit H1, same shape as
        // the USER_JOIN scope fix).
        //
        // Prefer the globally-unique serverPublicId when present — numeric
        // ids collide across federated instances (state.server.serverId
        // holds the active server's publicId). Numeric fallback for older
        // servers.
        const state = store.getState();
        if (serverPublicId !== undefined) {
          if (serverPublicId !== state.server.serverId) return;
        } else if (serverId !== state.app.activeServerId) {
          return;
        }
        removeUser(userId);
        // Phase B B4 — lazy rotation on kick/leave. Mark every E2EE
        // channel in this server dirty so the next encrypt rotates the
        // chain (new senderKeyId) and SKDMs only the still-visible
        // members. Some channels may not have included the leaver, but
        // over-rotation is cheap and the alternative (per-channel
        // membership query) round-trips for every kick.
        const e2eeChannels = store
          .getState()
          .server.channels.filter((c) => c.e2ee);
        for (const channel of e2eeChannels) {
          markChainForRotation('channel', channel.id).catch((err) => {
            console.warn(
              `[E2EE] Failed to mark channel ${channel.id} dirty after kick of ${userId}:`,
              err
            );
          });
        }
      }
    ),
    subscribe(
      'onKicked',
      trpc.users.onKicked,
      ({ serverId, serverPublicId, reason }) => {
        toast.error(
          reason
            ? `You have been kicked: ${reason}`
            : 'You have been kicked from the server'
        );

        const state = store.getState();

        // Remove the server from the joined list. Match by the
        // globally-unique publicId when present — the numeric id alone can
        // collide with a federated server's id, and removing by number
        // would drop the WRONG entry (e.g. a kick arriving from a federated
        // connection removing the home server that shares its numeric id).
        // Numeric fallback for older servers.
        if (serverPublicId !== undefined) {
          removeServerEntryByPublicId(serverPublicId);
        } else {
          store.dispatch(appSliceActions.removeJoinedServer(serverId));
        }

        // If we're currently viewing the kicked server, navigate to home
        // (state.server.serverId holds the active server's publicId).
        const viewingKickedServer =
          serverPublicId !== undefined
            ? state.server.serverId === serverPublicId
            : state.app.activeServerId === serverId;
        if (viewingKickedServer) {
          resetServerState();
          setActiveView('home');
          store.dispatch(appSliceActions.setActiveServerId(undefined));
          if (state.app.activeInstanceDomain) {
            setActiveInstanceDomain(null);
          }
        }
      }
    )
  );
};

export { subscribeToUsers };
