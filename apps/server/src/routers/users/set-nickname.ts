import { ActivityLogType, Permission, ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerMemberIds } from '../../db/queries/servers';
import { getPublicUserById } from '../../db/queries/users';
import { serverMembers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { enqueueActivityLog } from '../../queues/activity-log';

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
      // publishFor, NOT publish: user-facing subscriptions listen on
      // per-user topics (subscribeFor); plain publish() emits on a channel
      // none of them watch, so the update reached no client and the UI
      // only caught up on a full refresh. Nickname is per-server data —
      // scope delivery to co-members (self included).
      const memberIds = await getServerMemberIds(ctx.activeServerId);
      ctx.pubsub.publishFor(
        Array.from(new Set([...memberIds, ctx.userId])),
        ServerEvents.USER_UPDATE,
        user
      );
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
      enqueueActivityLog({
        type: ActivityLogType.USER_NICKNAME_SET,
        userId: input.userId,
        serverId: ctx.activeServerId,
        details: { nickname: input.nickname, setBy: ctx.userId }
      });
      // Same delivery fix as setNicknameRoute above.
      const memberIds = await getServerMemberIds(ctx.activeServerId);
      ctx.pubsub.publishFor(
        Array.from(new Set([...memberIds, ctx.userId])),
        ServerEvents.USER_UPDATE,
        user
      );
    }
  });

export { setNicknameRoute, setUserNicknameRoute };
