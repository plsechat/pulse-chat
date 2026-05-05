import {
  ChannelPermission,
  ServerEvents,
  UserStatus,
  type Permission,
  type TUser
} from '@pulse/shared';
import { initTRPC, TRPCError } from '@trpc/server';
import chalk from 'chalk';
import type WebSocket from 'ws';
import { config } from '../config';
import { getUserById } from '../db/queries/users';
import { logger } from '../logger';
import type { TConnectionInfo } from '../types';
import { invariant } from './invariant';
import {
  getLogContext,
  newRequestId,
  updateLogContext,
  withLogContext
} from './log-context';
import { pubsub } from './pubsub';

export type Context = {
  handshakeHash: string;
  authenticated: boolean;
  pubsub: typeof pubsub;
  user: TUser;
  userId: number;
  accessToken: string;
  activeServerId: number | undefined;
  currentVoiceChannelId: number | undefined;
  currentDmVoiceChannelId: number | undefined;
  hasPermission: (
    targetPermission: Permission | Permission[],
    serverId?: number
  ) => Promise<boolean>;
  needsPermission: (
    targetPermission: Permission | Permission[],
    serverId?: number
  ) => Promise<void>;
  hasChannelPermission: (
    channelId: number,
    targetPermission: ChannelPermission
  ) => Promise<boolean>;
  needsChannelPermission: (
    channelId: number,
    targetPermission: ChannelPermission
  ) => Promise<void>;
  getOwnWs: () => WebSocket | undefined;
  getStatusById: (userId: number) => UserStatus;
  setUserStatus: (userId: number, status: UserStatus) => void;
  setWsUserId: (userId: number) => void;
  getUserWs: (userId: number) => Set<WebSocket> | undefined;
  getConnectionInfo: () => TConnectionInfo | undefined;
  throwValidationError: (field: string, message: string) => never;
  saveUserIp: (userId: number, ip: string) => Promise<void>;
  invalidatePermissionCache: () => void;
};

const t = initTRPC.context<Context>().create();

const timingMiddleware = t.middleware(async ({ path, type, ctx, next }) => {
  // Run the tRPC invocation inside an async-local log context so any
  // downstream `logger.*` call carries the userId + route. HTTP-mounted
  // tRPC requests already have a scope (seeded by the http server
  // entry); WS-mounted ones don't, so we create one here. Per-call so
  // each subscription / mutation on the same WS gets its own requestId.
  const userIdStamp = typeof ctx.userId === 'number' ? { userId: ctx.userId } : {};
  const apply = async () => {
    if (!config.server.debug) {
      return next();
    }

    logger.debug('[tRPC] > %s %s userId=%s', type, path, ctx.userId ?? '-');

    const start = performance.now();
    try {
      const result = await next();
      const duration = performance.now() - start;
      logger.debug(
        `${chalk.dim('[tRPC]')} < ${chalk.yellow(path)} ${chalk.green(duration.toFixed(2))}ms`
      );
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      const code = error instanceof TRPCError ? error.code : 'UNKNOWN';
      logger.debug(
        '[tRPC] ! %s %s %s %sms %o',
        type,
        path,
        code,
        duration.toFixed(2),
        error
      );
      throw error;
    }
  };

  if (getLogContext()) {
    updateLogContext({ ...userIdStamp, route: path });
    return apply();
  }
  return withLogContext(
    { requestId: newRequestId(), ...userIdStamp, route: path },
    apply
  );
});

const authMiddleware = t.middleware(async ({ ctx, next }) => {
  invariant(ctx.authenticated, {
    code: 'UNAUTHORIZED',
    message: 'You must be authenticated to perform this action.'
  });

  // Re-check banned status on every request (ban may have been applied after connection)
  const freshUser = await getUserById(ctx.userId);
  invariant(freshUser && !freshUser.banned, {
    code: 'FORBIDDEN',
    message: 'User is banned'
  });

  return next();
});

// this should be used for all queries and mutations apart from the join server one
// it prevents users that only are connected to the wss but did not join the server from accessing protected procedures
const protectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(authMiddleware);

const publicProcedure = t.procedure.use(timingMiddleware);

/**
 * Build a tRPC subscription that delivers a per-user-scoped pubsub topic.
 * Replaces the boilerplate that was repeated across 16 router events.ts
 * files: every wrapper was the same `protectedProcedure.subscription
 * (({ctx}) => ctx.pubsub.subscribeFor(ctx.userId, X))`.
 */
const userSubscription = <T extends ServerEvents>(event: T) =>
  protectedProcedure.subscription(({ ctx }) =>
    ctx.pubsub.subscribeFor(ctx.userId, event)
  );

export { protectedProcedure, publicProcedure, t, userSubscription };
