import {
  ActivityLogType,
  getRandomString,
  Permission,
  ServerEvents
} from '@pulse/shared';
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
      serverId: z.number().int().positive(),
      maxUses: z.number().int().min(0).max(100).optional().default(0),
      // 0 / null / absent all mean "never expires" (the client sends 0).
      expiresAt: z
        .number()
        .int()
        .min(0)
        .optional()
        .nullable()
        .default(null)
        .transform((value) => (value ? value : null)),
      code: z.string().min(4).max(64).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_INVITES, input.serverId);

    if (input.expiresAt && input.expiresAt <= Date.now()) {
      ctx.throwValidationError('expiresAt', 'Expiry must be in the future');
    }

    const newCode = input.code || getRandomString(24);

    // Use onConflictDoNothing to handle concurrent inserts with the same code
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
      .onConflictDoNothing()
      .returning();

    invariant(invite, {
      code: 'CONFLICT',
      message: 'An invite with this code already exists'
    });

    // Notify server members so admin invite lists update
    const memberIds = await getServerMemberIds(input.serverId);
    ctx.pubsub.publishFor(memberIds, ServerEvents.INVITE_CREATE, {
      inviteId: invite.id,
      serverId: input.serverId
    });

    enqueueActivityLog({
      type: ActivityLogType.CREATED_INVITE,
      userId: ctx.user.id,
      details: {
        code: invite.code,
        maxUses: invite.maxUses || 0,
        expiresAt: invite.expiresAt
      }
    });

    return invite;
  });

export { addInviteRoute };
