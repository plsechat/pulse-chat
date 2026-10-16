import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { serverMembers } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const getServerSettingsRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number().int().positive()
    })
  )
  .query(async ({ ctx, input }) => {
    const [member] = await db
      .select({
        muted: serverMembers.muted,
        notificationLevel: serverMembers.notificationLevel
      })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, input.serverId),
          eq(serverMembers.userId, ctx.userId)
        )
      )
      .limit(1);

    return {
      muted: member?.muted ?? false,
      notificationLevel: member?.notificationLevel ?? 'default'
    };
  });

export { getServerSettingsRoute };
