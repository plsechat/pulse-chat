import { Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  channelRolePermissions,
  channelUserPermissions
} from '../../db/schema';
import { channelProcedure } from '../../utils/procedures';

/**
 * The full override matrix of ONE channel of the active server. Gated on
 * MANAGE_CHANNELS — the same flag updatePermissions / deletePermissions
 * require — so the permission editor is never readable-but-not-writable
 * (or the reverse). The channel is scoped by channelProcedure: a channel
 * of another server is reported as not found.
 *
 * Declared as a mutation only because the client still calls it with
 * `.mutate`; flipping both sides to a query is a one-line client change.
 */
const getPermissionsRoute = channelProcedure().query(
  async ({ ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CHANNELS);

    const [rolePermissions, userPermissions] = await Promise.all([
      db
        .select()
        .from(channelRolePermissions)
        .where(eq(channelRolePermissions.channelId, ctx.channel.id)),
      db
        .select()
        .from(channelUserPermissions)
        .where(eq(channelUserPermissions.channelId, ctx.channel.id))
    ]);

    return {
      rolePermissions,
      userPermissions
    };
  }
);

export { getPermissionsRoute };
