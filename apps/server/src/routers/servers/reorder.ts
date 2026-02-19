import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { serverMembers } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const reorderServersRoute = protectedProcedure
  .input(
    z.object({
      serverIds: z.array(z.number())
    })
  )
  .mutation(async ({ input, ctx }) => {
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
