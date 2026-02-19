import {
  ActivityLogType,
  getRandomString,
  Permission,
  ServerEvents
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerMemberIds } from '../../db/queries/servers';
import { invites } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const addInviteRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number(),
      maxUses: z.number().min(0).max(100).optional().default(0),
      expiresAt: z.number().optional().nullable().default(null),
      code: z.string().min(4).max(64).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_INVITES, input.serverId);

    const newCode = input.code || getRandomString(24);
    const [existingInvite] = await db
      .select()
      .from(invites)
      .where(eq(invites.code, newCode))
      .limit(1);

    invariant(!existingInvite, {
      code: 'CONFLICT',
      message: 'An invite with this code already exists'
    });

    const [invite] = await db
      .insert(invites)
      .values({
        code: newCode,
        creatorId: ctx.user.id,
        serverId: input.serverId,
        maxUses: input.maxUses || null,
        uses: 0,
        expiresAt: input.expiresAt || null,
        createdAt: Date.now()
      })
      .returning();

    // Notify server members so admin invite lists update
    const memberIds = await getServerMemberIds(input.serverId);
    ctx.pubsub.publishFor(memberIds, ServerEvents.INVITE_CREATE, {
      inviteId: invite!.id,
      serverId: input.serverId
    });

    enqueueActivityLog({
      type: ActivityLogType.CREATED_INVITE,
      userId: ctx.user.id,
      details: {
        code: invite!.code,
        maxUses: invite!.maxUses || 0,
        expiresAt: invite!.expiresAt
      }
    });

    return invite;
  });

export { addInviteRoute };
