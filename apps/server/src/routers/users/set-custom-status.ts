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
      customStatus: z.string().trim().min(1).max(128).nullable(),
      // Optional emoji (unicode char or a custom-emoji shortcode) shown
      // beside the status. Cleared when null or when the status is cleared.
      emoji: z.string().trim().max(64).nullable().optional(),
      // Optional auto-expiry, in minutes from now. When set, the status
      // (and emoji) read as cleared once it passes — expired lazily on
      // read, no cron. Bounded to a week.
      expiresInMinutes: z
        .number()
        .int()
        .positive()
        .max(60 * 24 * 7)
        .nullable()
        .optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const clearing = input.customStatus === null;
    const emoji = clearing ? null : input.emoji ?? null;
    const expiresAt =
      clearing || !input.expiresInMinutes
        ? null
        : Date.now() + input.expiresInMinutes * 60_000;

    await db
      .update(users)
      .set({
        customStatus: input.customStatus,
        customStatusEmoji: emoji,
        customStatusExpiresAt: expiresAt,
        updatedAt: Date.now()
      })
      .where(eq(users.id, ctx.userId));

    // Broadcast to co-members (payload carries the fresh customStatus)
    publishUser(ctx.userId, 'update');

    // Push to peer instances holding a shadow user for me
    relayUserInfoUpdate(ctx.userId, {
      customStatus: input.customStatus,
      customStatusEmoji: emoji
    });
  });

export { setCustomStatusRoute };
