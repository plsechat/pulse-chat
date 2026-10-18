import {
  removeServerEntryByPublicId,
  setActiveInstanceDomain,
  setActiveView
} from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { dmsSliceActions } from '@/features/dms/slice';
import { updateFriend } from '@/features/friends/actions';
import { reinitServerSubscriptions, resetServerState } from '@/features/server/actions';
import { store } from '@/features/store';
import {
  distributeSenderKeysToOnlineMember,
  getActiveE2eeInstance,
  invalidateChannelMembers,
  markChainForRotation
} from '@/lib/e2ee';
import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import { UserStatus } from '@pulse/shared';
import { toast } from 'sonner';
import { addUser, handleUserJoin, removeUser, updateUser } from './actions';

/**
 * The join event arrived on the active server's socket, so the joiner's
 * id and the channel ids are in the active instance's id space — hand
 * lib/e2ee that instance explicitly rather than letting it guess from
 * ambient state.
 */
async function distributeE2eeKeysToUser(joinedUserId: number): Promise<void> {
  const e2eeChannelIds = store
    .getState()
    .server.channels.filter((c) => c.e2ee)
    .map((c) => c.id);
  if (e2eeChannelIds.length === 0) return;
  const instance = await getActiveE2eeInstance();
  if (!instance) return;
  await distributeSenderKeysToOnlineMember(
    joinedUserId,
    instance,
    e2eeChannelIds
  );
}

const sameRoleIds = (a: number[], b: number[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

const subscribeToUsers = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    // A member's client session connected to the server (the
    // bootstrap). A NEW member arrives on servers.onMemberJoin.
    subscribe('onUserConnected', trpc.users.onConnected, (payload) => {
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
    subscribe('onUserUpdate', trpc.users.onUpdate, (payload) => {
      // Game presence is per server: a scoped update carries it as the
      // named server may show it, so only that server's roster takes
      // it — a client viewing another server keeps its own copy, and
      // the home-scoped mirrors (friends, DM members) never carry it.
      // An unscoped update has no `gamePresence` key at all, and a
      // missing key leaves the roster's value alone.
      const { scopeServerPublicId, gamePresence, ...user } = payload;
      const state = store.getState();
      const presenceForThisRoster =
        'gamePresence' in payload &&
        (scopeServerPublicId === undefined ||
          scopeServerPublicId === state.server.serverId)
          ? { gamePresence }
          : {};
      // A role grant can make an encrypted channel visible to this
      // user; the cached roster predates it and would keep them off
      // the SKDM target list. Presence-only updates leave it alone.
      const before = state.server.users.find((u) => u.id === user.id);
      if (before && !sameRoleIds(before.roleIds, user.roleIds)) {
        invalidateChannelMembers();
      }
      updateUser(user.id, { ...user, ...presenceForThisRoster });
      updateFriend(user.id, user);
      // Mirror the FULL profile onto cached DM member projections —
      // for a partner who is neither friend nor co-member this is
      // their only live representation (cosmetics went stale before).
      // The reducer preserves presence when status is omitted.
      store.dispatch(dmsSliceActions.updateMemberProfile(user));
    }),
    subscribe(
      'onUserDelete',
      trpc.users.onDelete,
      ({ serverId, serverPublicId, userId }) => {
        // Server-scoped delete (kick/ban/leave from `serverId`). Only mutate
        // the local roster when we're actually viewing that server, otherwise
        // we'd corrupt the active server's user list (audit H1, same shape as
        // the USER_CONNECTED scope fix).
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
            // The server subs were bound to the peer's client; rebind
            // them to home or they stay dead until the next switch.
            reinitServerSubscriptions();
          }
        }
      }
    )
  );
};

export { subscribeToUsers };
