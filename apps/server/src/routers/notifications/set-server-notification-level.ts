import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { serverMembers } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const setServerNotificationLevelRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number().int().positive(),
      level: z.enum(['all', 'mentions', 'nothing', 'default'])
    })
  )
  .mutation(async ({ ctx, input }) => {
    await db
      .update(serverMembers)
      .set({ notificationLevel: input.level })
      .where(
        and(
          eq(serverMembers.serverId, input.serverId),
          eq(serverMembers.userId, ctx.userId)
        )
      );
  });

export { setServerNotificationLevelRoute };
