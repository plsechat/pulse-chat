import { ActivityLogType, Permission, ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerMemberIds } from '../../db/queries/servers';
import { getPublicUserById } from '../../db/queries/users';
import { serverMembers } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { enqueueActivityLog } from '../../queues/activity-log';

const setNicknameRoute = serverProcedure()
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
    const updated = await db
      .update(serverMembers)
      .set({ nickname: input.nickname })
      .where(
        and(
          eq(serverMembers.serverId, ctx.activeServerId),
          eq(serverMembers.userId, ctx.userId)
        )
      )
      .returning({ userId: serverMembers.userId });

    invariant(updated.length > 0, {
      code: 'FORBIDDEN',
      message: 'You are not a member of this server'
    });

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

const setUserNicknameRoute = serverProcedure(Permission.MANAGE_USERS)
  .input(
    z.object({
      userId: z.number().int().positive(),
      nickname: z
        .string()
        .max(32)
        .transform((s) => s.trim())
        .pipe(z.string().min(1))
        .nullable()
    })
  )
  .mutation(async ({ ctx, input }) => {
    // A non-member updates 0 rows; refuse instead of publishing a
    // nickname for someone who is not in the server.
    const updated = await db
      .update(serverMembers)
      .set({ nickname: input.nickname })
      .where(
        and(
          eq(serverMembers.serverId, ctx.activeServerId),
          eq(serverMembers.userId, input.userId)
        )
      )
      .returning({ userId: serverMembers.userId });

    invariant(updated.length > 0, {
      code: 'NOT_FOUND',
      message: 'User is not a member of this server'
    });

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
