import { nameStyleSchema } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { users } from '../../db/schema';
import { relayUserInfoUpdate } from '../../utils/federation-user-info-dispatch';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Equip (or clear, with null) the caller's styled display name —
 * font/effect/colors rendered on HOME surfaces only (DM lists, friends,
 * profile cards); server chat keeps role colors authoritative. The
 * validated shape is stored verbatim in users.nameStyle (jsonb).
 */
const setNameStyleRoute = protectedProcedure
  .input(
    z.object({
      style: nameStyleSchema.nullable()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await db
      .update(users)
      .set({ nameStyle: input.style, updatedAt: Date.now() })
      .where(eq(users.id, ctx.userId));

    publishUser(ctx.userId, 'update');

    // Push to peer instances holding a shadow user for me. Fonts and
    // effects are client-bundled, so the value is portable as-is.
    relayUserInfoUpdate(ctx.userId, { nameStyle: input.style });
  });

export { setNameStyleRoute };
