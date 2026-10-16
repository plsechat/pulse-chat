import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { serverMembers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const reorderServersRoute = protectedProcedure
  .input(
    z.object({
      serverIds: z.array(z.number().int().positive()).max(200)
    })
  )
  .mutation(async ({ input, ctx }) => {
    invariant(new Set(input.serverIds).size === input.serverIds.length, {
      code: 'BAD_REQUEST',
      message: 'serverIds contains duplicates'
    });

    await db.transaction(async (tx) => {
      for (let i = 0; i < input.serverIds.length; i++) {
        const serverId = input.serverIds[i]!;

        await tx
          .update(serverMembers)
          .set({ position: i })
          .where(
            and(
              eq(serverMembers.serverId, serverId),
              eq(serverMembers.userId, ctx.user.id)
            )
          );
      }
    });
  });

export { reorderServersRoute };
