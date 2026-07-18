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
  getPresenceInterestedIds,
  getServerById
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
import { removeUserFromVoice } from './voice-cleanup';
import type { Context } from './trpc';

let wss: WebSocketServer | undefined;
const userStatusOverrides = new Map<number, UserStatus>();
const wsMapByToken = new Map<string, WebSocket>();
const wsMapByUserId = new Map<number, Set<WebSocket>>();

const usersIpMap = new Map<number, string>();

/**
 * Module-level mutator for the runtime user-status override map.
 * Used by the federation user-info push handler (E3) to flip a
 * federated shadow user's status when their home instance reports
 * a change. The per-context `setUserStatus` closure inside
 * `createContext` mutates the same map, so this is just a shared
 * front door for callers without a context.
 */
const setRuntimeUserStatus = (userId: number, status: UserStatus) => {
  if (status === UserStatus.ONLINE) {
    userStatusOverrides.delete(userId);
  } else {
    userStatusOverrides.set(userId, status);
  }
};

const getUserIp = (userId: number): string | undefined => {
  return usersIpMap.get(userId);
};

const createContext = async ({
  info,
  req,
  res
}: CreateWSSContextFnOptions): Promise<Context> => {
  const params = info.connectionParams as TConnectionParams;

  logger.debug('[wss/createContext] new connection, hasFederationToken=%s, hasAccessToken=%s',
    !!params.federationToken, !!params.accessToken);

  let decodedUser;
  let accessToken = params.accessToken;

  if (params.federationToken) {
    // Federation auth path
    logger.debug('[wss/createContext] federation auth path, token length=%d', params.federationToken.length);
    const fedResult = await verifyFederationToken(params.federationToken);
    logger.debug('[wss/createContext] federation token verification result=%o',
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
    logger.debug('[wss/createContext] shadow user id=%d, name=%s', decodedUser.id, decodedUser.name);

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

  if (decodedUser?.banned) {
    // Close with the BANNED code (not a generic FORBIDDEN) so the client
    // recognises this as non-recoverable and shows the banned screen with
    // the reason. Without this, a banned user whose client reconnects
    // (e.g. the ban raced a transient reconnect) loops on "Reconnecting…"
    // forever, since only DisconnectCode.BANNED is treated as terminal.
    // `res?.` — the mock context in unit tests has no res; the invariant
    // below still carries the rejection there.
    res?.close(DisconnectCode.BANNED, decodedUser.banReason ?? undefined);
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
    if (!user) {
      logger.debug(
        '[perm] denied reason=no-user serverId=%s target=%o',
        effectiveServerId,
        targetPermission
      );
      return false;
    }

    // Check if user is the server owner (bypasses all permission checks)
    if (effectiveServerId) {
      const server = await getCachedServer(effectiveServerId);
      if (server && server.ownerId === user.id) {
        logger.debug(
          '[perm] granted reason=owner userId=%d serverId=%s target=%o',
          user.id,
          effectiveServerId,
          targetPermission
        );
        return true;
      }
    }

    const roles = await getCachedUserRoles(user.id, effectiveServerId);
    const permissionsSet = new Set<Permission>();
    for (const role of roles) {
      for (const permission of role.permissions) {
        permissionsSet.add(permission);
      }
    }

    const granted = Array.isArray(targetPermission)
      ? targetPermission.every((p) => permissionsSet.has(p))
      : permissionsSet.has(targetPermission);
    logger.debug(
      '[perm] %s reason=role userId=%d serverId=%s target=%o',
      granted ? 'granted' : 'denied',
      user.id,
      effectiveServerId,
      targetPermission
    );
    return granted;
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

    if (!channelRecord) {
      logger.debug(
        '[chan-perm] denied reason=channel-not-found channelId=%d target=%o',
        channelId,
        targetPermission
      );
      return false;
    }

    // Ensure the channel belongs to the caller's active server
    if (_activeServer.id && channelRecord.serverId !== _activeServer.id) {
      logger.debug(
        '[chan-perm] denied reason=cross-server channelId=%d activeServerId=%d target=%o',
        channelId,
        _activeServer.id,
        targetPermission
      );
      return false;
    }

    if (!channelRecord.private) {
      logger.debug(
        '[chan-perm] granted reason=public channelId=%d target=%o',
        channelId,
        targetPermission
      );
      return true;
    }

    const user = await getCachedUser();
    if (!user) {
      logger.debug(
        '[chan-perm] denied reason=no-user channelId=%d target=%o',
        channelId,
        targetPermission
      );
      return false;
    }

    // Check if user is server owner (bypasses channel permissions)
    const server = await getCachedServer(channelRecord.serverId);
    if (server && server.ownerId === user.id) {
      logger.debug(
        '[chan-perm] granted reason=owner userId=%d channelId=%d target=%o',
        user.id,
        channelId,
        targetPermission
      );
      return true;
    }

    const userChannelPermissions = await getCachedChannelPermissions();
    const channelInfo = userChannelPermissions[channelId];
    if (!channelInfo) {
      logger.debug(
        '[chan-perm] denied reason=no-permissions-row userId=%d channelId=%d target=%o',
        user.id,
        channelId,
        targetPermission
      );
      return false;
    }
    if (!channelInfo.permissions[ChannelPermission.VIEW_CHANNEL]) {
      logger.debug(
        '[chan-perm] denied reason=cannot-view userId=%d channelId=%d target=%o',
        user.id,
        channelId,
        targetPermission
      );
      return false;
    }

    const granted = channelInfo.permissions[targetPermission] === true;
    logger.debug(
      '[chan-perm] %s reason=role userId=%d channelId=%d target=%o',
      granted ? 'granted' : 'denied',
      user.id,
      channelId,
      targetPermission
    );
    return granted;
  };

  const getOwnWs = () => wsMapByToken.get(accessToken);

  const getUserWs = (userId: number) => wsMapByUserId.get(userId);

  const getStatusById = (userId: number) => {
    const connections = wsMapByUserId.get(userId);

    if (!connections || connections.size === 0) return UserStatus.OFFLINE;

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
      let connections = wsMapByUserId.get(userId);
      if (!connections) {
        connections = new Set();
        wsMapByUserId.set(userId, connections);
      }
      connections.add(ws);
    }
  };

  // Stamp voice-session ownership on the socket (see declarations.d.ts).
  // Setting a channel clears the stamp on the user's OTHER sockets so a
  // zombie connection's delayed close can't tear down the session a
  // fresh connection just (re)joined.
  const setWsVoiceChannelId = (channelId?: number) => {
    const ws = wsMapByToken.get(accessToken);
    if (!ws) return;

    if (ws.userId === undefined) ws.userId = decodedUser.id;
    ws.voiceChannelId = channelId;

    if (channelId !== undefined) {
      for (const other of wsMapByUserId.get(ws.userId) ?? []) {
        if (other !== ws) other.voiceChannelId = undefined;
      }
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
    setWsVoiceChannelId,
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

      logger.debug('[WS] connection open');

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
        logger.debug('[WS] connection close userId=%s', ws.userId ?? '-');

        // Clean up the token map only if it still points at THIS socket.
        // A refreshed page reuses the same access token, so the old
        // socket's close must not delete the NEW socket's registration —
        // that made setWsUserId a no-op for the fresh connection and
        // permanently broke its own eventual cleanup.
        if (ws.token && wsMapByToken.get(ws.token) === ws) {
          wsMapByToken.delete(ws.token);
        }

        // Remove THIS connection from the per-user Set.
        // Only do full cleanup when the last connection closes.
        let isLastConnection = false;
        if (ws.userId !== undefined) {
          const connections = wsMapByUserId.get(ws.userId);
          if (connections) {
            connections.delete(ws);
            if (connections.size === 0) {
              wsMapByUserId.delete(ws.userId);
              isLastConnection = true;
            }
          } else {
            isLastConnection = true;
          }
        }

        // Voice teardown runs for EVERY closing socket that owns a voice
        // session — independent of the last-connection gate (voice
        // membership belongs to the connection that joined, not the
        // account) and of token validity (a token that expired mid-call
        // must not leak the runtime entry). The ownership stamp keeps an
        // overlapping reconnect that already re-joined from being evicted
        // by the old socket's delayed close.
        if (ws.userId !== undefined && ws.voiceChannelId !== undefined) {
          try {
            const runtime = VoiceRuntime.findRuntimeByUserId(ws.userId);
            if (runtime && runtime.id === ws.voiceChannelId) {
              await removeUserFromVoice(ws.userId);
            }
          } catch (err) {
            logger.error(
              'Voice cleanup failed during WS close for user %d:',
              ws.userId,
              err
            );
          }
        }

        if (!isLastConnection) return;

        let user;

        try {
          // Resolve by the userId already authenticated at join time —
          // never by re-verifying the connect-time token, which may have
          // expired during the session and would silently skip USER_LEAVE
          // (peers keep a stale ONLINE dot until the next refetch).
          if (ws.userId !== undefined) {
            user = await getUserById(ws.userId);
          }

          if (!user) {
            // Fallback for sockets that never completed a join.
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
          }
        } catch (err) {
          logger.error('Failed to resolve user during WS close:', err);
        }

        if (!user) return;

        // Safety net for sessions without an ownership stamp (e.g. a
        // socket that lost voiceChannelId): the account's last connection
        // is gone, so any remaining runtime entry is unreachable.
        try {
          await removeUserFromVoice(user.id);
        } catch (err) {
          logger.error('Voice cleanup failed during WS close for user %d:', user.id, err);
        }

        // Always clean up user state, even if voice cleanup failed
        usersIpMap.delete(user.id);
        userStatusOverrides.delete(user.id);

        try {
          // Scope USER_LEAVE to everyone with a presence interest —
          // server co-members, DM partners, and friends. The client
          // handler is presence-only (flips status to offline), so the
          // broader audience is safe.
          const interestedIds = await getPresenceInterestedIds(user.id);
          pubsub.publishFor(interestedIds, ServerEvents.USER_LEAVE, user.id);
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
      keepAlive: {
        enabled: true,
        pingMs: 30_000,
        pongWaitMs: 5_000
      },
      onError: ({ error, path, type, ctx }) => {
        logger.error('[tRPC/onError] path=%s, type=%s, code=%s, message=%s, userId=%s',
          path, type, error.code, error.message, ctx?.userId);
      }
    });

    resolve(wss);
  });
};

/**
 * True when the user has at least one live WS connection. Used by the
 * orphan-voice sweep to reconcile in-memory voice membership against
 * actual connections.
 */
const hasLiveWsConnection = (userId: number): boolean =>
  (wsMapByUserId.get(userId)?.size ?? 0) > 0;

export {
  createContext,
  createWsServer,
  getUserIp,
  hasLiveWsConnection,
  setRuntimeUserStatus
};
