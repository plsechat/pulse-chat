import {
  ActivityLogType,
  ChannelType,
  ServerEvents,
  type TChannelUserPermissionsMap,
  type TCommandsMapByPlugin,
  type TMentionStateMap,
  type TReadStateMap,
  type TUserPreferences
} from '@pulse/shared';
import type {
  TCategory,
  TChannel,
  TJoinedRole,
  TPublicServerSettings
} from '../../types';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import {
  getAllChannelUserPermissions,
  getChannelsReadStatesForUser,
  getForumUnreadForUser,
  toWireChannel
} from '../../db/queries/channels';
import { getRolesForServer } from '../../db/queries/roles';
import { getServerPublicSettings } from '../../db/queries/server';
import {
  getServerById,
  getServerMemberIds,
  getServersByUserId,
  isInstanceOwner,
  isServerMember
} from '../../db/queries/servers';
import { getPublicUserById } from '../../db/queries/users';
import { categories, channels, userPreferences, users } from '../../db/schema';
import { logger } from '../../logger';
import { pluginManager } from '../../plugins';
import { eventBus } from '../../plugins/event-bus';
import { enqueueActivityLog } from '../../queues/activity-log';
import { enqueueLogin } from '../../queues/logins';
import { relayPresenceConnected } from '../../utils/federation-user-info-dispatch';
import { invariant } from '../../utils/invariant';
import { publicProcedure } from '../../utils/trpc';

// The WebSocket session bootstrap: authenticates the socket against the
// handshake and selects the active server (one the user is already a
// member of). Becoming a member is servers.joinByInvite / joinDiscover /
// joinFederated.
//
// publicProcedure (not protectedProcedure): this IS the route that sets
// `authenticated`; it still runs through timingMiddleware so the
// bootstrap call carries a requestId / route in the logs.
const openSessionRoute = publicProcedure
  .input(
    z.object({
      handshakeHash: z.string(),
      serverId: z.number().optional()
    })
  )
  .query(async ({ input, ctx }) => {
    invariant(ctx.user, {
      code: 'UNAUTHORIZED',
      message: 'User not authenticated'
    });

    // Federated users are already authenticated via their token — skip
    // handshake validation which is for local auth only
    if (!ctx.user.isFederated) {
      invariant(
        input.handshakeHash &&
          ctx.handshakeHash &&
          input.handshakeHash === ctx.handshakeHash,
        {
          code: 'FORBIDDEN',
          message: 'Invalid handshake hash'
        }
      );
    }

    ctx.authenticated = true;
    // Captured before the socket registers: a re-join on an already
    // registered socket (server switch) must not count as a connect.
    const socketsBefore = ctx.getUserWs(ctx.user.id)?.size ?? 0;
    ctx.setWsUserId(ctx.user.id);

    // Presence to peers that hold a shadow of this user — only for the
    // FIRST live socket of a local account, and only when the socket is
    // actually registered (a test caller has none). Federated users'
    // presence is their home's to announce.
    if (
      config.federation.enabled &&
      !ctx.user.isFederated &&
      socketsBefore === 0 &&
      ctx.getUserWs(ctx.user.id)?.size === 1
    ) {
      relayPresenceConnected(ctx.user.id, ctx.getStatusById(ctx.user.id));
    }

    // Find the user's joined servers
    const userServers = await getServersByUserId(ctx.user.id);

    // Instance-level federation facts for the client's UI gating: whether
    // this user owns the instance's first server (the operator), and
    // whether the operator lets other server owners make servers
    // federatable. Both reflect THIS instance (federated connections get
    // the remote's values; the federation UI is home-only anyway).
    const isInstanceOwnerFlag = await isInstanceOwner(ctx.user.id);
    const federatableServersAllowed =
      config.federation.allowUserFederatableServers;

    // If user has no servers, return a minimal response so the client can show the discover view
    if (userServers.length === 0) {
      const connectionInfo = ctx.getConnectionInfo();

      if (connectionInfo?.ip) {
        ctx.saveUserIp(ctx.user.id, connectionInfo.ip);
      }

      await db
        .update(users)
        .set({ lastLoginAt: Date.now() })
        .where(eq(users.id, ctx.user.id));

      enqueueLogin(ctx.user.id, connectionInfo);

      const [prefsRow] = await db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, ctx.user.id));

      return {
        categories: [] as TCategory[],
        channels: [] as TChannel[],
        serverId: '',
        serverName: '',
        serverDbId: 0,
        ownUserId: ctx.user.id,
        roles: [] as TJoinedRole[],
        publicSettings: undefined as TPublicServerSettings | undefined,
        channelPermissions: {} as TChannelUserPermissionsMap,
        readStates: {} as TReadStateMap,
        mentionStates: {} as TMentionStateMap,
        lastReadMessageIds: {} as Record<number, number | null>,
        commands: {} as TCommandsMapByPlugin,
        userPreferences: (prefsRow?.data as TUserPreferences) ?? undefined,
        isInstanceOwner: isInstanceOwnerFlag,
        federatableServersAllowed
      };
    }

    // Resolve which server to load — must be one the user is a member of
    let targetServer;
    if (input.serverId) {
      const isMember = await isServerMember(input.serverId, ctx.user.id);
      if (isMember) {
        targetServer = await getServerById(input.serverId);
      }
    }
    // Fall back to the user's first joined server
    if (!targetServer) {
      targetServer = await getServerById(userServers[0]!.id);
    }

    invariant(targetServer, {
      code: 'NOT_FOUND',
      message: 'No server found'
    });

    ctx.activeServerId = targetServer.id;
    // Joining a real server ends any read-only preview session — the
    // preview VIEW_CHANNEL carve-out must not outlive it.
    ctx.previewServerId = undefined;

    const [
      allCategories,
      channelsForUser,
      roles,
      channelPermissions,
      readStatesResult,
      userPrefsRows,
      publicSettings
    ] = await Promise.all([
      db
        .select()
        .from(categories)
        .where(eq(categories.serverId, targetServer.id)),
      db
        .select()
        .from(channels)
        .where(eq(channels.serverId, targetServer.id))
        .then((rows) => rows.map(toWireChannel)),
      getRolesForServer(targetServer.id),
      getAllChannelUserPermissions(ctx.user.id, targetServer.id),
      getChannelsReadStatesForUser(ctx.user.id, undefined, targetServer.id),
      db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, ctx.user.id)),
      getServerPublicSettings(targetServer.id)
    ]);

    logger.info(`%s connected to the server`, ctx.user.name);

    // Publish USER_CONNECTED to members of this server
    const ownPublicUser = await getPublicUserById(ctx.user.id);
    if (ownPublicUser) {
      const memberIds = await getServerMemberIds(targetServer.id);
      ctx.pubsub.publishFor(memberIds, ServerEvents.USER_CONNECTED, {
        serverId: targetServer.id,
        serverPublicId: targetServer.publicId,
        user: {
          ...ownPublicUser,
          status: ctx.getStatusById(ctx.user.id),
          _identity: ownPublicUser._identity?.includes('@')
            ? ownPublicUser._identity
            : undefined
        }
      });
    }

    // USER_CONNECTED is server-scoped, so DM partners and friends who
    // share no server never learn the user came online. Publish a global
    // status update for them — publishUser fans out to every
    // presence-interested id (co-members, DM partners, friends), and the
    // client handlers (updateUser/updateFriend) are idempotent. Not
    // awaited: presence is best-effort and must not delay the join.
    publishUser(ctx.user.id, 'update', {
      statusOverride: ctx.getStatusById(ctx.user.id)
    }).catch((err) => {
      logger.error('Failed to publish join presence for user %d:', ctx.user.id, err);
    });

    const connectionInfo = ctx.getConnectionInfo();

    if (connectionInfo?.ip) {
      ctx.saveUserIp(ctx.user.id, connectionInfo.ip);
    }

    await db
      .update(users)
      .set({ lastLoginAt: Date.now() })
      .where(eq(users.id, ctx.user.id));

    enqueueLogin(ctx.user.id, connectionInfo);
    enqueueActivityLog({
      type: ActivityLogType.USER_JOINED,
      userId: ctx.user.id,
      ip: connectionInfo?.ip
    });

    const connectedPayload = {
      userId: ctx.user.id,
      username: ctx.user.name,
      serverId: targetServer.id
    };
    eventBus.emit('user:connected', connectedPayload);
    // Deprecated alias of user:connected, emitted for one release so
    // plugins written against the old name keep working. v0.4.0 ships
    // both; delete this emit in v0.5.0.
    eventBus.emit('user:joined', connectedPayload);

    // Aggregate unread counts for forum channels from their child threads
    const forumChannels = channelsForUser.filter((c) => c.type === ChannelType.FORUM);
    const { readStates, mentionStates } = readStatesResult;

    if (forumChannels.length > 0) {
      const forumResults = await Promise.all(
        forumChannels.map((f) => getForumUnreadForUser(ctx.user.id, f.id))
      );

      forumChannels.forEach((f, i) => {
        const result = forumResults[i]!;
        if (result.unreadCount > 0) readStates[f.id] = result.unreadCount;
        if (result.mentionCount > 0) mentionStates[f.id] = result.mentionCount;
      });
    }

    return {
      categories: allCategories,
      channels: channelsForUser,
      serverId: targetServer.publicId,
      serverName: targetServer.name,
      serverDbId: targetServer.id,
      ownUserId: ctx.user.id,
      roles,
      publicSettings,
      channelPermissions,
      readStates,
      mentionStates,
      lastReadMessageIds: readStatesResult.lastReadMessageIds,
      // Plugin commands only where the server has them switched on — the
      // same gate plugins.getCommands applies.
      commands: (await pluginManager.commandsEnabledForServer(targetServer.id))
        ? pluginManager.getCommands()
        : ({} as TCommandsMapByPlugin),
      userPreferences:
        (userPrefsRows[0]?.data as TUserPreferences) ?? undefined,
      isInstanceOwner: isInstanceOwnerFlag,
      federatableServersAllowed
    };
  });

export { openSessionRoute };
