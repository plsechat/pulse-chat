import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { publishUser } from '../../db/publishers';
import { nameplates, users } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deleteNameplateRoute = protectedProcedure
  .input(
    z.object({
      id: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_EMOJIS);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const [removedNameplate] = await db
      .delete(nameplates)
      .where(
        and(
          eq(nameplates.id, input.id),
          eq(nameplates.serverId, ctx.activeServerId)
        )
      )
      .returning();

    invariant(removedNameplate, {
      code: 'NOT_FOUND',
      message: 'Nameplate not found'
    });

    await removeFile(removedNameplate.fileId);

    // Un-equip everyone wearing the deleted pack and tell their
    // co-members (publishUser fans out per-recipient via publishFor).
    const unequipped = await db
      .update(users)
      .set({ nameplate: null, updatedAt: Date.now() })
      .where(eq(users.nameplate, `custom:${removedNameplate.id}`))
      .returning({ id: users.id });

    for (const user of unequipped) {
      publishUser(user.id, 'update');
    }
  });

export { deleteNameplateRoute };
