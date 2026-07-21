import type { ChannelPermission, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { isInstanceOwner } from '../db/queries/servers';
import { channels } from '../db/schema';
import { invariant } from './invariant';
import { protectedProcedure } from './trpc';

/**
 * Composable authorization builders.
 *
 * The historical pattern — every handler remembering to call
 * ctx.needsPermission() / scope-check fetched rows by hand — fails OPEN
 * when an author forgets: nothing errors, the route just ships
 * unguarded (the May security audit's cross-server-scope criticals were
 * exactly this). These builders make the check part of the procedure
 * type instead, so a route built on them cannot skip it.
 *
 * New routes use these. Existing routes migrate as they're touched.
 */

/**
 * Requires an active server on the connection; optionally one or more
 * server permissions (same any/all semantics as ctx.needsPermission).
 * Narrows ctx.activeServerId to number for the handler.
 */
const serverProcedure = (permission?: Permission | Permission[]) =>
  protectedProcedure.use(async ({ ctx, next }) => {
    const activeServerId = ctx.activeServerId;

    invariant(activeServerId !== undefined, {
      code: 'FORBIDDEN',
      message: 'No active server for this connection'
    });

    if (permission !== undefined) {
      await ctx.needsPermission(permission);
    }

    return next({ ctx: { activeServerId } });
  });

/**
 * Requires a `channelId` input naming a channel of the caller's ACTIVE
 * server, and optionally a channel permission on it. A channel outside
 * the active server is reported identically to a nonexistent one so the
 * route can't be used as a cross-server existence/occupancy oracle.
 * The loaded row is provided as ctx.channel; routes chain their own
 * .input() for additional fields.
 */
const channelProcedure = (permission?: ChannelPermission) =>
  protectedProcedure
    .input(z.object({ channelId: z.number().int().positive() }))
    .use(async ({ ctx, input, next }) => {
      const [channel] = await db
        .select()
        .from(channels)
        .where(eq(channels.id, input.channelId))
        .limit(1);

      invariant(channel && channel.serverId === ctx.activeServerId, {
        code: 'NOT_FOUND',
        message: 'Channel not found'
      });

      if (permission !== undefined) {
        await ctx.needsChannelPermission(channel.id, permission);
      }

      return next({ ctx: { channel } });
    });

/**
 * Instance-operator surface (admin panel, federation config,
 * registration controls): the owner of the bootstrap server alone —
 * NOT any server owner, who holds every per-server permission on their
 * own server and previously satisfied MANAGE_SETTINGS-style gates.
 */
const instanceOwnerProcedure = protectedProcedure.use(
  async ({ ctx, next }) => {
    invariant(await isInstanceOwner(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'Only the instance owner can perform this action'
    });

    return next();
  }
);

export { channelProcedure, instanceOwnerProcedure, serverProcedure };
