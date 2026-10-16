import { ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { getServerPublicSettings } from '../../db/queries/server';
import {
  getServerById,
  getServerMemberIds,
  isServerMember,
  isServerOwner
} from '../../db/queries/servers';
import { getUserById } from '../../db/queries/users';
import { roles, servers, userRoles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { invalidatePermissionCacheForUser } from '../../utils/permission-cache-registry';
import { protectedProcedure } from '../../utils/trpc';

const transferOwnerRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number().int().positive(),
      newOwnerId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const server = await getServerById(input.serverId);

    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    invariant(await isServerOwner(input.serverId, ctx.userId), {
      code: 'FORBIDDEN',
      message: 'Only the server owner can transfer ownership'
    });

    invariant(input.newOwnerId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You already own this server'
    });

    const targetIsMember = await isServerMember(
      input.serverId,
      input.newOwnerId
    );

    invariant(targetIsMember, {
      code: 'BAD_REQUEST',
      message: 'Target user is not a member of this server'
    });

    // Ownership must land on an account that can actually act as owner:
    // not deleted, not banned, and home to this instance (a federated
    // shadow user cannot administer a local server).
    const target = await getUserById(input.newOwnerId);

    invariant(target && !target.deletedAt && !target.banned && !target.isFederated, {
      code: 'BAD_REQUEST',
      message: 'This user cannot become the server owner'
    });

    await db
      .update(servers)
      .set({
        ownerId: input.newOwnerId,
        updatedAt: Date.now()
      })
      .where(eq(servers.id, input.serverId));

    // Move the all-permissions Owner ROLE with the ownership — otherwise
    // the previous owner keeps full permissions and the new owner has
    // none. Identified by capability flags (persistent + non-default),
    // the same test the add/remove-role guards use.
    const [ownerRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.serverId, input.serverId),
          eq(roles.isPersistent, true),
          eq(roles.isDefault, false)
        )
      )
      .limit(1);

    if (ownerRole) {
      await db
        .delete(userRoles)
        .where(
          and(
            eq(userRoles.roleId, ownerRole.id),
            eq(userRoles.userId, ctx.userId)
          )
        );
      await db
        .insert(userRoles)
        .values({
          userId: input.newOwnerId,
          roleId: ownerRole.id,
          createdAt: Date.now()
        })
        .onConflictDoNothing();
    }

    // Both sides' live permissions changed: the caller's cache and every
    // connection the new owner holds (they would otherwise keep the old
    // ownerId and role set until they reconnect).
    ctx.invalidatePermissionCache();
    invalidatePermissionCacheForUser(input.newOwnerId);

    // Tell clients: both users' role sets changed (badges, rosters) and
    // the server's ownerId changed (owner-only UI).
    publishUser(input.newOwnerId, 'update');
    publishUser(ctx.userId, 'update');

    const [publicSettings, memberIds] = await Promise.all([
      getServerPublicSettings(input.serverId),
      getServerMemberIds(input.serverId)
    ]);
    ctx.pubsub.publishFor(
      memberIds,
      ServerEvents.SERVER_SETTINGS_UPDATE,
      publicSettings
    );
  });

export { transferOwnerRoute };
