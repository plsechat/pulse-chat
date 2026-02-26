import {
  ActivityLogType,
  ChannelType,
  ServerEvents,
  type TCategory,
  type TChannel,
  type TChannelUserPermissionsMap,
  type TExternalStreamsMap,
  type TJoinedEmoji,
  type TJoinedPublicUser,
  type TJoinedRole,
  type TMentionStateMap,
  type TPublicServerSettings,
  type TReadStateMap,
  type TUserPreferences,
  type TVoiceMap
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  getAllChannelUserPermissions,
  getChannelsReadStatesForUser,
  getForumUnreadForUser
} from '../../db/queries/channels';
import { getEmojis } from '../../db/queries/emojis';
import { getRolesForServer } from '../../db/queries/roles';
import { getServerPublicSettings } from '../../db/queries/server';
import {
  getServerById,
  getServerMemberIds,
  getServersByUserId,
  isServerMember
} from '../../db/queries/servers';
import { getPublicUsersForServer } from '../../db/queries/users';
import { categories, channels, userPreferences, users } from '../../db/schema';
import { logger } from '../../logger';
import { pluginManager } from '../../plugins';
import { eventBus } from '../../plugins/event-bus';
import { enqueueActivityLog } from '../../queues/activity-log';
import { enqueueLogin } from '../../queues/logins';
import { VoiceRuntime } from '../../runtimes/voice';
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
        users: [] as TJoinedPublicUser[],
        serverId: '',
        serverName: '',
        serverDbId: 0,
        ownUserId: ctx.user.id,
        voiceMap: {} as TVoiceMap,
        roles: [] as TJoinedRole[],
        emojis: [] as TJoinedEmoji[],
        publicSettings: undefined as TPublicServerSettings | undefined,
        channelPermissions: {} as TChannelUserPermissionsMap,
        readStates: {} as TReadStateMap,
        mentionStates: {} as TMentionStateMap,
        commands: pluginManager.getCommands(),
        externalStreamsMap: {} as TExternalStreamsMap,
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
      publicUsers,
      roles,
      emojis,
      channelPermissions,
      readStatesResult,
      userPrefsRows
    ] = await Promise.all([
      db
        .select()
        .from(categories)
        .where(eq(categories.serverId, targetServer.id)),
      db
        .select()
        .from(channels)
        .where(eq(channels.serverId, targetServer.id)),
      getPublicUsersForServer(targetServer.id),
      getRolesForServer(targetServer.id),
      getEmojis(targetServer.id),
      getAllChannelUserPermissions(ctx.user.id, targetServer.id),
      getChannelsReadStatesForUser(ctx.user.id, undefined, targetServer.id),
      db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, ctx.user.id))
    ]);

    const processedPublicUsers = publicUsers.map((u) => ({
      ...u,
      status: ctx.getStatusById(u.id),
      _identity: u._identity?.includes('@') ? u._identity : undefined
    }));

    const foundPublicUser = processedPublicUsers.find(
      (u) => u.id === ctx.user.id
    );

    invariant(foundPublicUser, {
      code: 'NOT_FOUND',
      message: 'User not present in public users'
    });

    logger.info(`%s joined the server`, ctx.user.name);

    const publicSettings = await getServerPublicSettings(targetServer.id);

    // Publish USER_JOIN to members of this server
    const memberIds = await getServerMemberIds(targetServer.id);
    ctx.pubsub.publishFor(memberIds, ServerEvents.USER_JOIN, foundPublicUser);

    const connectionInfo = ctx.getConnectionInfo();

    if (connectionInfo?.ip) {
      ctx.saveUserIp(ctx.user.id, connectionInfo.ip);
    }

    const serverChannelIds = new Set(channelsForUser.map((c) => c.id));
    const voiceMap = VoiceRuntime.getVoiceMap(serverChannelIds);
    const externalStreamsMap = VoiceRuntime.getExternalStreamsMap(serverChannelIds);

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
      users: processedPublicUsers,
      serverId: targetServer.publicId,
      serverName: targetServer.name,
      serverDbId: targetServer.id,
      ownUserId: ctx.user.id,
      voiceMap,
      roles,
      emojis,
      publicSettings,
      channelPermissions,
      readStates,
      mentionStates,
      lastReadMessageIds: readStatesResult.lastReadMessageIds,
      commands: pluginManager.getCommands(),
      externalStreamsMap,
      userPreferences:
        (userPrefsRows[0]?.data as TUserPreferences) ?? undefined
    };
  });

export { joinServerRoute };
