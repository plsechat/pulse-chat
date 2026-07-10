import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { users } from '../../db/schema';
import { relayUserInfoUpdate } from '../../utils/federation-user-info-dispatch';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Set (or clear, with null) the caller's custom status text — the short
 * presence line under the display name ("🎧 working late"). Persisted on
 * the user row like bio, unlike the runtime-only ONLINE/IDLE/DND status.
 */
const setCustomStatusRoute = protectedProcedure
  .input(
    z.object({
      customStatus: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .nullable()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await db
      .update(users)
      .set({ customStatus: input.customStatus, updatedAt: Date.now() })
      .where(eq(users.id, ctx.userId));

    // Broadcast to co-members (payload carries the fresh customStatus)
    publishUser(ctx.userId, 'update');

    // Push to peer instances holding a shadow user for me
    relayUserInfoUpdate(ctx.userId, { customStatus: input.customStatus });
  });

export { setCustomStatusRoute };
