import {
  ActivityLogType,
  ChannelPermission,
  DisconnectCode,
  Permission,
  ServerEvents,
  UserStatus,
  type TChannelUserPermissionsMap,
  type TConnectionParams,
  type TJoinedRole,
  type TJoinedServer,
  type TJoinedUser
} from '@pulse/shared';
import { TRPCError } from '@trpc/server';
import {
  applyWSSHandler,
  type CreateWSSContextFnOptions
} from '@trpc/server/adapters/ws';
import { eq } from 'drizzle-orm';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { db } from '../db';
import { findOrCreateShadowUser, syncShadowUserProfile } from '../db/mutations/federation';
import { getAllChannelUserPermissions } from '../db/queries/channels';
import {
  getServerById,
  getServerMemberIds,
  getServersByUserId
} from '../db/queries/servers';
import { getUserById, getUserByToken } from '../db/queries/users';
import { channels } from '../db/schema';
import { getWsInfo } from '../helpers/get-ws-info';
import { logger } from '../logger';
import { enqueueActivityLog } from '../queues/activity-log';
import { appRouter } from '../routers';
import { getUserRoles } from '../routers/users/get-user-roles';
import { VoiceRuntime } from '../runtimes/voice';
import { verifyFederationToken } from './federation';
import { invariant } from './invariant';
import { pubsub } from './pubsub';
import type { Context } from './trpc';

let wss: WebSocketServer | undefined;
const userStatusOverrides = new Map<number, UserStatus>();
const wsMapByToken = new Map<string, WebSocket>();
const wsMapByUserId = new Map<number, WebSocket>();

const usersIpMap = new Map<number, string>();

const getUserIp = (userId: number): string | undefined => {
  return usersIpMap.get(userId);
};

const createContext = async ({
  info,
  req,
  res
}: CreateWSSContextFnOptions): Promise<Context> => {
  const params = info.connectionParams as TConnectionParams;

  logger.info('[wss/createContext] new connection, hasFederationToken=%s, hasAccessToken=%s',
    !!params.federationToken, !!params.accessToken);

  let decodedUser;
  let accessToken = params.accessToken;

  if (params.federationToken) {
    // Federation auth path
    logger.info('[wss/createContext] federation auth path, token length=%d', params.federationToken.length);
    const fedResult = await verifyFederationToken(params.federationToken);
    logger.info('[wss/createContext] federation token verification result=%o',
      fedResult ? { userId: fedResult.userId, username: fedResult.username, instanceId: fedResult.instanceId } : null);

    if (!fedResult) {
      res.close(DisconnectCode.FEDERATION_REJECTED, 'Invalid federation token');
    }

    invariant(fedResult, {
      code: 'UNAUTHORIZED',
      message: 'Invalid federation token'
    });

    decodedUser = await findOrCreateShadowUser(
      fedResult.instanceId,
      fedResult.userId,
      fedResult.username,
      fedResult.avatar,
      fedResult.publicId
    );
    logger.info('[wss/createContext] shadow user id=%d, name=%s', decodedUser.id, decodedUser.name);

    // Sync profile (avatar, banner, bio) from home instance — await with timeout
    // so the profile data is ready before the client's first request
    await Promise.race([
      syncShadowUserProfile(decodedUser.id, fedResult.issuerDomain, fedResult.publicId),
      Bun.sleep(3000)
    ]);

    // Use the federation token itself for WS client matching
    accessToken = params.federationToken;
  } else {
    // Standard Supabase auth path
    decodedUser = await getUserByToken(accessToken);

    invariant(decodedUser, {
      code: 'UNAUTHORIZED',
      message: 'Invalid authentication token'
    });
  }

  invariant(!decodedUser.banned, {
    code: 'FORBIDDEN',
    message: 'User is banned'
  });

  // Per-connection permission cache (lazy-loaded, invalidated on mutations)
  let _cachedUser: TJoinedUser | undefined;
  const _cachedServerMap = new Map<number, TJoinedServer | undefined>();
  const _cachedRolesMap = new Map<string, TJoinedRole[]>();
  let _cachedChannelPerms: TChannelUserPermissionsMap | undefined;

  const getCachedUser = async () => {
    if (!_cachedUser) _cachedUser = await getUserById(decodedUser.id);
    return _cachedUser;
  };

  const getCachedServer = async (serverId: number) => {
    if (!_cachedServerMap.has(serverId))
      _cachedServerMap.set(serverId, await getServerById(serverId));
    return _cachedServerMap.get(serverId);
  };

  const getCachedUserRoles = async (userId: number, serverId?: number) => {
    const key = `${userId}:${serverId ?? 'all'}`;
    if (!_cachedRolesMap.has(key))
      _cachedRolesMap.set(key, await getUserRoles(userId, serverId));
    return _cachedRolesMap.get(key)!;
  };

  const getCachedChannelPermissions = async () => {
    if (!_cachedChannelPerms)
      _cachedChannelPerms = await getAllChannelUserPermissions(decodedUser.id, _activeServer.id);
    return _cachedChannelPerms;
  };

  const invalidatePermissionCache = () => {
    _cachedUser = undefined;
    _cachedServerMap.clear();
    _cachedRolesMap.clear();
    _cachedChannelPerms = undefined;
  };

  const _activeServer = { id: undefined as number | undefined };

  const hasPermission = async (
    targetPermission: Permission | Permission[],
    serverId?: number
  ) => {
    // Default to the active server so callers that omit serverId
    // are scoped to the current server instead of checking globally.
    const effectiveServerId = serverId ?? _activeServer.id;

    const user = await getCachedUser();

    if (!user) return false;

    // Check if user is the server owner (bypasses all permission checks)
    if (effectiveServerId) {
      const server = await getCachedServer(effectiveServerId);
      if (server && server.ownerId === user.id) return true;
    }

    const roles = await getCachedUserRoles(user.id, effectiveServerId);

    const permissionsSet = new Set<Permission>();

    for (const role of roles) {
      for (const permission of role.permissions) {
        permissionsSet.add(permission);
      }
    }

    if (Array.isArray(targetPermission)) {
      return targetPermission.every((p) => permissionsSet.has(p));
    }

    return permissionsSet.has(targetPermission);
  };

  const hasChannelPermission = async (
    channelId: number,
    targetPermission: ChannelPermission
  ) => {
    const [channelRecord] = await db
      .select({
        private: channels.private,
        serverId: channels.serverId
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    if (!channelRecord) return false;

    // Ensure the channel belongs to the caller's active server
    if (_activeServer.id && channelRecord.serverId !== _activeServer.id)
      return false;

    if (!channelRecord.private) return true;

    const user = await getCachedUser();

    if (!user) return false;

    // Check if user is server owner (bypasses channel permissions)
    const server = await getCachedServer(channelRecord.serverId);
    if (server && server.ownerId === user.id) return true;

    const userChannelPermissions = await getCachedChannelPermissions();

    const channelInfo = userChannelPermissions[channelId];

    if (!channelInfo) return false;
    if (!channelInfo.permissions[ChannelPermission.VIEW_CHANNEL]) return false;

    return channelInfo.permissions[targetPermission] === true;
  };

  const getOwnWs = () => wsMapByToken.get(accessToken);

  const getUserWs = (userId: number) => wsMapByUserId.get(userId);

  const getStatusById = (userId: number) => {
    const isConnected = wsMapByUserId.has(userId);

    if (!isConnected) return UserStatus.OFFLINE;

    // Check for user-set status override
    const override = userStatusOverrides.get(userId);

    if (override === UserStatus.INVISIBLE) return UserStatus.OFFLINE;
    if (override) return override;

    return UserStatus.ONLINE;
  };

  const setUserStatus = (userId: number, status: UserStatus) => {
    if (status === UserStatus.ONLINE) {
      userStatusOverrides.delete(userId);
    } else {
      userStatusOverrides.set(userId, status);
    }
  };

  const setWsUserId = (userId: number) => {
    const ws = wsMapByToken.get(accessToken);

    if (ws) {
      ws.userId = userId;
      wsMapByUserId.set(userId, ws);
    }
  };

  const getConnectionInfo = () => {
    const ws = wsMapByToken.get(accessToken);

    if (!ws) return undefined;

    return getWsInfo(ws, req);
  };

  const needsPermission = async (
    targetPermission: Permission | Permission[],
    serverId?: number
  ) => {
    invariant(await hasPermission(targetPermission, serverId), {
      code: 'FORBIDDEN',
      message: 'Insufficient permissions'
    });
  };

  const needsChannelPermission = async (
    channelId: number,
    targetPermission: ChannelPermission
  ) => {
    invariant(await hasChannelPermission(channelId, targetPermission), {
      code: 'FORBIDDEN',
      message: 'Insufficient channel permissions'
    });
  };

  const throwValidationError = (field: string, message: string) => {
    // this mimics the zod validation error format
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: JSON.stringify([
        {
          code: 'custom',
          path: [field],
          message
        }
      ])
    });
  };

  const saveUserIp = async (userId: number, ip: string) => {
    usersIpMap.set(userId, ip);
  };

  // Federated connections are authenticated via their token — no handshake/join needed
  const isFederated = !!params.federationToken;

  return {
    pubsub,
    accessToken,
    user: decodedUser,
    authenticated: isFederated,
    userId: decodedUser.id,
    handshakeHash: '',
    get activeServerId() { return _activeServer.id; },
    set activeServerId(id: number | undefined) { _activeServer.id = id; },
    currentVoiceChannelId: undefined,
    currentDmVoiceChannelId: undefined,
    hasPermission,
    needsPermission,
    hasChannelPermission,
    needsChannelPermission,
    getOwnWs,
    getStatusById,
    setUserStatus,
    setWsUserId,
    getUserWs,
    getConnectionInfo,
    throwValidationError,
    saveUserIp,
    invalidatePermissionCache
  };
};

const createWsServer = async (server: http.Server) => {
  return new Promise<WebSocketServer>((resolve) => {
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      ws.userId = undefined;
      ws.token = '';

      ws.once('message', async (message) => {
        try {
          const parsed = JSON.parse(message.toString());
          const params = parsed.data as TConnectionParams;

          // Store federation token if present and use it as the matching token
          if (params.federationToken) {
            ws.federationToken = params.federationToken;
            ws.token = params.federationToken;
          } else {
            ws.token = params.accessToken;
          }

          // Populate lookup Maps for O(1) access
          if (ws.token) wsMapByToken.set(ws.token, ws);
        } catch {
          logger.error('Failed to parse initial WebSocket message');
        }
      });

      ws.on('close', async () => {
        // Clean up lookup Maps immediately (before any async work)
        if (ws.token) wsMapByToken.delete(ws.token);
        if (ws.userId !== undefined) wsMapByUserId.delete(ws.userId);

        let user;

        try {
          // Handle federated user disconnect
          const fedToken = ws.federationToken;
          if (fedToken) {
            const fedResult = await verifyFederationToken(fedToken).catch(
              () => null
            );
            if (fedResult) {
              user = await getUserById(
                (
                  await findOrCreateShadowUser(
                    fedResult.instanceId,
                    fedResult.userId,
                    fedResult.username,
                    undefined,
                    fedResult.publicId
                  )
                ).id
              );
            }
          } else {
            user = await getUserByToken(ws.token);
          }
        } catch (err) {
          logger.error('Failed to resolve user during WS close:', err);
        }

        if (!user) return;

        try {
          const voiceRuntime = VoiceRuntime.findRuntimeByUserId(user.id);

          if (voiceRuntime) {
            voiceRuntime.removeUser(user.id);

            // Scope voice leave to server members or DM members
            if (voiceRuntime.isDmVoice) {
              const { getDmChannelMemberIds } = await import('../db/queries/dms');
              const dmMemberIds = await getDmChannelMemberIds(voiceRuntime.id);
              pubsub.publishFor(dmMemberIds, ServerEvents.USER_LEAVE_VOICE, {
                channelId: voiceRuntime.id,
                userId: user.id,
                startedAt: voiceRuntime.getState().startedAt
              });
            } else {
              const [ch] = await db
                .select({ serverId: channels.serverId })
                .from(channels)
                .where(eq(channels.id, voiceRuntime.id))
                .limit(1);
              if (ch) {
                const voiceMemberIds = await getServerMemberIds(ch.serverId);
                pubsub.publishFor(voiceMemberIds, ServerEvents.USER_LEAVE_VOICE, {
                  channelId: voiceRuntime.id,
                  userId: user.id,
                  startedAt: voiceRuntime.getState().startedAt
                });
              }
            }

            // If this was a DM voice call and no users remain, destroy the runtime
            if (voiceRuntime.isDmVoice && voiceRuntime.getState().users.length === 0) {
              await voiceRuntime.destroy();
              const { getDmChannelMemberIds } = await import('../db/queries/dms');
              const memberIds = await getDmChannelMemberIds(voiceRuntime.id);
              pubsub.publishFor(memberIds, ServerEvents.DM_CALL_ENDED, {
                dmChannelId: voiceRuntime.id
              });
            } else if (voiceRuntime.isDmVoice) {
              const { getDmChannelMemberIds } = await import('../db/queries/dms');
              const memberIds = await getDmChannelMemberIds(voiceRuntime.id);
              pubsub.publishFor(memberIds, ServerEvents.DM_CALL_USER_LEFT, {
                dmChannelId: voiceRuntime.id,
                userId: user.id
              });
            } else if (voiceRuntime.getState().users.length === 0) {
              // Destroy empty server voice runtimes to free mediasoup resources
              await voiceRuntime.destroy();
            }
          }
        } catch (err) {
          logger.error('Voice cleanup failed during WS close for user %d:', user.id, err);
        }

        // Always clean up user state, even if voice cleanup failed
        usersIpMap.delete(user.id);
        userStatusOverrides.delete(user.id);

        try {
          // Scope USER_LEAVE to members of the user's servers
          const userServers = await getServersByUserId(user.id);
          const allMemberIds = new Set<number>();
          for (const server of userServers) {
            const memberIds = await getServerMemberIds(server.id);
            for (const id of memberIds) allMemberIds.add(id);
          }
          pubsub.publishFor([...allMemberIds], ServerEvents.USER_LEAVE, user.id);
        } catch (err) {
          logger.error('Failed to publish USER_LEAVE for user %d:', user.id, err);
        }

        logger.info('%s left the server', user.name);

        enqueueActivityLog({
          type: ActivityLogType.USER_LEFT,
          userId: user.id
        });
      });

      ws.on('error', (err) => {
        logger.error('WebSocket client error:', err);
      });
    });

    wss.on('close', () => {
      logger.debug('WebSocket server closed');
    });

    wss.on('error', (err) => {
      logger.error('WebSocket server error:', err);
    });

    applyWSSHandler({
      wss,
      router: appRouter,
      createContext,
      onError: ({ error, path, type, ctx }) => {
        logger.error('[tRPC/onError] path=%s, type=%s, code=%s, message=%s, userId=%s',
          path, type, error.code, error.message, ctx?.userId);
      }
    });

    resolve(wss);
  });
};

export { createContext, createWsServer, getUserIp };
