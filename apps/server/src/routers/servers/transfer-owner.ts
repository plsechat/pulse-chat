import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  getServerById,
  isServerMember,
  isServerOwner
} from '../../db/queries/servers';
import { roles, servers, userRoles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const transferOwnerRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number(),
      newOwnerId: z.number()
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

    const targetIsMember = await isServerMember(
      input.serverId,
      input.newOwnerId
    );

    invariant(targetIsMember, {
      code: 'BAD_REQUEST',
      message: 'Target user is not a member of this server'
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

    ctx.invalidatePermissionCache();
  });

export { transferOwnerRoute };
