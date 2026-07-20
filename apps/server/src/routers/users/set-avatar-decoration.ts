import { AVATAR_DECORATION_SLUGS } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { users } from '../../db/schema';
import { relayUserInfoUpdate } from '../../utils/federation-user-info-dispatch';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Equip (or clear, with null) the caller's avatar decoration — the
 * animated frame drawn around their avatar. Only 'preset:<slug>' values
 * exist (the APNG assets are bundled with the client), validated against
 * the built-in list.
 */
const setAvatarDecorationRoute = protectedProcedure
  .input(
    z.object({
      decoration: z.string().max(40).nullable()
    })
  )
  .mutation(async ({ ctx, input }) => {
    if (input.decoration !== null) {
      const slug = input.decoration.startsWith('preset:')
        ? input.decoration.slice('preset:'.length)
        : null;

      invariant(slug !== null && AVATAR_DECORATION_SLUGS.includes(slug), {
        code: 'BAD_REQUEST',
        message: 'Unknown avatar decoration'
      });
    }

    await db
      .update(users)
      .set({ avatarDecoration: input.decoration, updatedAt: Date.now() })
      .where(eq(users.id, ctx.userId));

    publishUser(ctx.userId, 'update');

    // Push to peer instances holding a shadow user for me. Presets are
    // client-bundled assets, so the value is portable as-is.
    relayUserInfoUpdate(ctx.userId, { avatarDecoration: input.decoration });
  });

export { setAvatarDecorationRoute };
