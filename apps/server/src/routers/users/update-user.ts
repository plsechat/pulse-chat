import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { isDisplayNameTaken } from '../../db/queries/users';
import { users } from '../../db/schema';
import { relayUserInfoUpdate } from '../../utils/federation-user-info-dispatch';
import { protectedProcedure } from '../../utils/trpc';

const updateUserRoute = protectedProcedure
  .input(
    z.object({
      name: z.string().min(1).max(24),
      bannerColor: z
        .string()
        .regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color'),
      bio: z.string().max(160).optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const nameTaken = await isDisplayNameTaken(input.name, ctx.userId);

    if (nameTaken) {
      ctx.throwValidationError('name', 'This display name is already taken');
    }

    const [updatedUser] = await db
      .update(users)
      .set({
        name: input.name,
        bannerColor: input.bannerColor,
        bio: input.bio ?? null
      })
      .where(eq(users.id, ctx.userId))
      .returning();

    publishUser(updatedUser!.id, 'update');

    // Phase E / E3 — push profile changes to peer instances that
    // hold a shadow user for this user. Federated viewers see the
    // updated name / bio / bannerColor in real-time instead of
    // waiting for the next opportunistic profile pull.
    relayUserInfoUpdate(ctx.userId, {
      name: input.name,
      bannerColor: input.bannerColor,
      bio: input.bio ?? null
    });
  });

export { updateUserRoute };
