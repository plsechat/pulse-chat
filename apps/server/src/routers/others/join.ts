import {
  ActivityLogType,
  ChannelType,
  ServerEvents,
  type TCategory,
  type TChannel,
  type TChannelUserPermissionsMap,
  type TJoinedRole,
  type TMentionStateMap,
  type TPublicServerSettings,
  type TReadStateMap,
  type TUserPreferences
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  getAllChannelUserPermissions,
  getChannelsReadStatesForUser,
  getForumUnreadForUser
} from '../../db/queries/channels';
import { getRolesForServer } from '../../db/queries/roles';
import { getServerPublicSettings } from '../../db/queries/server';
import {
  getServerById,
  getServerMemberIds,
  getServersByUserId,
  isServerMember
} from '../../db/queries/servers';
import { getPublicUserById } from '../../db/queries/users';
import { categories, channels, userPreferences, users } from '../../db/schema';
import { logger } from '../../logger';
import { pluginManager } from '../../plugins';
import { eventBus } from '../../plugins/event-bus';
import { enqueueActivityLog } from '../../queues/activity-log';
import { enqueueLogin } from '../../queues/logins';
import { invariant } from '../../utils/invariant';
import { t } from '../../utils/trpc';

const joinServerRoute = t.procedure
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
    ctx.setWsUserId(ctx.user.id);

    // Find the user's joined servers
    const userServers = await getServersByUserId(ctx.user.id);

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
        commands: pluginManager.getCommands(),
        userPreferences: (prefsRow?.data as TUserPreferences) ?? undefined
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
        .where(eq(channels.serverId, targetServer.id)),
      getRolesForServer(targetServer.id),
      getAllChannelUserPermissions(ctx.user.id, targetServer.id),
      getChannelsReadStatesForUser(ctx.user.id, undefined, targetServer.id),
      db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, ctx.user.id)),
      getServerPublicSettings(targetServer.id)
    ]);

    logger.info(`%s joined the server`, ctx.user.name);

    // Publish USER_JOIN to members of this server
    const ownPublicUser = await getPublicUserById(ctx.user.id);
    if (ownPublicUser) {
      const memberIds = await getServerMemberIds(targetServer.id);
      ctx.pubsub.publishFor(memberIds, ServerEvents.USER_JOIN, {
        ...ownPublicUser,
        status: ctx.getStatusById(ctx.user.id),
        _identity: ownPublicUser._identity?.includes('@') ? ownPublicUser._identity : undefined
      });
    }

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

    eventBus.emit('user:joined', {
      userId: ctx.user.id,
      username: ctx.user.name
    });

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
      commands: pluginManager.getCommands(),
      userPreferences:
        (userPrefsRows[0]?.data as TUserPreferences) ?? undefined
    };
  });

export { joinServerRoute };
