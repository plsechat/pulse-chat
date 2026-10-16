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
 * Which one a route uses follows from what its input names:
 *   - nothing / a child object id (channel, role, emoji, message…)
 *     → serverProcedure: the ACTIVE server is the scope, and every
 *       fetch-by-id in the handler is filtered by ctx.activeServerId.
 *   - a channelId
 *     → channelProcedure: the channel is loaded and scoped for you.
 *   - a serverId
 *     → serverProcedureFor: the named server is the scope.
 *   - instance-operator surfaces → instanceOwnerProcedure.
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
 * Routes whose input names the server they act on (`serverId`): the
 * permission is evaluated in THAT server — owner or role there — so a
 * role held in server A never reaches server B. These are the server
 * settings / create-child routes the client calls for its active
 * server; the builder does not additionally require the named server to
 * be the connection's active one, because the caller's standing in the
 * named server is the whole authority (membership, roles and channel
 * overrides are dropped together on leave / kick / ban, see
 * removeServerMember), and an owner may address a server they just
 * created before the client has switched to it.
 */
const serverProcedureFor = (permission: Permission | Permission[]) =>
  protectedProcedure
    .input(z.object({ serverId: z.number().int().positive() }))
    .use(async ({ ctx, input, next }) => {
      await ctx.needsPermission(permission, input.serverId);

      return next();
    });

type ChannelProcedureOptions = {
  /**
   * How a channel of the caller's read-only PREVIEW server
   * (servers.preview) is treated.
   *
   * Omitted (default): out of scope — NOT_FOUND, the same shape as a
   * nonexistent channel. Right for routes a preview never exposes at
   * all (voice, channel overrides, notification settings).
   *
   * 'refuse': FORBIDDEN "Server preview is read-only". For routes on
   * channels the preview DOES list (text channels, whose messages a
   * previewer reads) that write state or enumerate members: a preview
   * grants exactly VIEW_CHANNEL on public channels, so the permission
   * check alone would let a VIEW-gated route through, and the channel's
   * existence is no secret, so the refusal says why.
   *
   * 'permit': the previewed channel is in scope and the channel
   * permission decides — the read paths previewers are meant to use
   * (messages, pins, threads), and routes whose permission a preview
   * never holds (SEND_MESSAGES), which it refuses like any outsider.
   */
  preview?: 'refuse' | 'permit';
  /**
   * Server-level permission the caller must also hold, evaluated in
   * the channel's server. Checked AFTER the channel permission so a
   * private-channel outsider is told about the channel, not the server.
   */
  serverPermission?: Permission | Permission[];
};

/**
 * Requires a `channelId` input naming a channel of the caller's ACTIVE
 * server (or, with a preview option, of the server they preview), and
 * optionally a channel permission on it. A channel outside that scope
 * is reported identically to a nonexistent one so the route can't be
 * used as a cross-server existence/occupancy oracle. The loaded row is
 * provided as ctx.channel and ctx.isPreview says whether it came in
 * through the preview carve-out; routes chain their own .input() for
 * additional fields.
 */
const channelProcedure = (
  permission?: ChannelPermission,
  options: ChannelProcedureOptions = {}
) =>
  protectedProcedure
    .input(z.object({ channelId: z.number().int().positive() }))
    .use(async ({ ctx, input, next }) => {
      const [channel] = await db
        .select()
        .from(channels)
        .where(eq(channels.id, input.channelId))
        .limit(1);

      // Same precedence as hasChannelPermission (utils/wss.ts): a
      // channel of the previewed server is a preview channel first.
      const isPreview =
        channel !== undefined &&
        ctx.previewServerId !== undefined &&
        channel.serverId === ctx.previewServerId;

      const previewInScope = isPreview && options.preview !== undefined;

      invariant(
        channel &&
          (channel.serverId === ctx.activeServerId || previewInScope),
        {
          code: 'NOT_FOUND',
          message: 'Channel not found'
        }
      );

      invariant(!isPreview || options.preview === 'permit', {
        code: 'FORBIDDEN',
        message: 'Server preview is read-only'
      });

      if (permission !== undefined) {
        await ctx.needsChannelPermission(channel.id, permission);
      }

      if (options.serverPermission !== undefined) {
        await ctx.needsPermission(options.serverPermission, channel.serverId);
      }

      return next({ ctx: { channel, isPreview } });
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

export {
  channelProcedure,
  instanceOwnerProcedure,
  serverProcedure,
  serverProcedureFor
};
