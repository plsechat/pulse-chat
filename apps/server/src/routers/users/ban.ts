import { ActivityLogType, DisconnectCode, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { isServerMember } from '../../db/queries/servers';
import { users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { relayFederatedModeration } from '../../utils/federation-moderation-dispatch';
import { markBanned } from '../../utils/banned-cache';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const banRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number(),
      reason: z.string().optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_USERS);

    invariant(input.userId !== ctx.user.id, {
      code: 'BAD_REQUEST',
      message: 'You cannot ban yourself.'
    });

    // Verify target user is a member of the caller's active server
    const isMember = await isServerMember(ctx.activeServerId!, input.userId);

    invariant(isMember, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    const userConnections = ctx.getUserWs(input.userId);

    if (userConnections) {
      for (const ws of userConnections) {
        ws.close(DisconnectCode.BANNED, input.reason);
      }
    }

    await db
      .update(users)
      .set({
        banned: true,
        banReason: input.reason ?? null,
        bannedAt: Date.now()
      })
      .where(eq(users.id, input.userId));

    // Reflect the new banned-state in the in-memory cache the auth
    // middleware reads from. Any subsequent protected procedure call
    // by this user (across any of their tabs / WS connections) is
    // rejected without a DB round-trip.
    markBanned(input.userId);

    // Two events: a global 'update' so co-members across every shared server
    // see the banned flag flip (e.g. for "this user is banned" indicators),
    // and a server-scoped 'delete' so the active server's user list drops
    // them — same UX as kick.
    publishUser(input.userId, 'update');
    publishUser(input.userId, 'delete', { scopeServerId: ctx.activeServerId! });

    // Federated member? Tell their home instance so its membership
    // record is removed and the user learns why (fire-and-forget).
    relayFederatedModeration(
      input.userId,
      ctx.activeServerId!,
      'ban',
      input.reason
    );

    enqueueActivityLog({
      type: ActivityLogType.USER_BANNED,
      userId: input.userId,
      serverId: ctx.activeServerId,
      details: {
        reason: input.reason,
        bannedBy: ctx.userId
      }
    });
  });

export { banRoute };
