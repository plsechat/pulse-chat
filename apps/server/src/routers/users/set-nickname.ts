import { Permission, ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getPublicUserById } from '../../db/queries/users';
import { serverMembers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const setNicknameRoute = protectedProcedure
  .input(
    z.object({
      nickname: z
        .string()
        .max(32)
        .transform((s) => s.trim())
        .pipe(z.string().min(1))
        .nullable()
    })
  )
  .mutation(async ({ ctx, input }) => {
    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    await db
      .update(serverMembers)
      .set({ nickname: input.nickname })
      .where(
        and(
          eq(serverMembers.serverId, ctx.activeServerId),
          eq(serverMembers.userId, ctx.userId)
        )
      );

    const user = await getPublicUserById(ctx.userId);
    if (user) {
      user.nickname = input.nickname;
      ctx.pubsub.publish(ServerEvents.USER_UPDATE, user);
    }
  });

const setUserNicknameRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number(),
      nickname: z
        .string()
        .max(32)
        .transform((s) => s.trim())
        .pipe(z.string().min(1))
        .nullable()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_USERS);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    await db
      .update(serverMembers)
      .set({ nickname: input.nickname })
      .where(
        and(
          eq(serverMembers.serverId, ctx.activeServerId),
          eq(serverMembers.userId, input.userId)
        )
      );

    const user = await getPublicUserById(input.userId);
    if (user) {
      user.nickname = input.nickname;
      ctx.pubsub.publish(ServerEvents.USER_UPDATE, user);
    }
  });

export { setNicknameRoute, setUserNicknameRoute };
