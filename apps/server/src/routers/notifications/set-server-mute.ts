import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { serverMembers } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const setServerMuteRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number().int().positive(),
      muted: z.boolean()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await db
      .update(serverMembers)
      .set({ muted: input.muted })
      .where(
        and(
          eq(serverMembers.serverId, input.serverId),
          eq(serverMembers.userId, ctx.userId)
        )
      );
  });

export { setServerMuteRoute };
