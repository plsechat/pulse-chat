import { NAMEPLATE_PRESET_SLUGS } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { canUserEquipNameplate } from '../../db/queries/nameplates';
import { users } from '../../db/schema';
import { relayUserInfoUpdate } from '../../utils/federation-user-info-dispatch';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Equip (or clear, with null) the caller's nameplate — the decorative
 * background behind their row in member/DM lists. Two sources:
 * 'preset:<slug>' (client-rendered CSS, slug validated against the
 * built-in list) and 'custom:<id>' (a server-admin-uploaded image pack;
 * the caller must be a member of the pack's server).
 */
const setNameplateRoute = protectedProcedure
  .input(
    z.object({
      nameplate: z.string().max(40).nullable()
    })
  )
  .mutation(async ({ ctx, input }) => {
    if (input.nameplate !== null) {
      if (input.nameplate.startsWith('preset:')) {
        const slug = input.nameplate.slice('preset:'.length);

        invariant(NAMEPLATE_PRESET_SLUGS.includes(slug), {
          code: 'BAD_REQUEST',
          message: 'Unknown nameplate preset'
        });
      } else if (/^custom:\d{1,9}$/.test(input.nameplate)) {
        const nameplateId = Number(input.nameplate.slice('custom:'.length));

        invariant(await canUserEquipNameplate(nameplateId, ctx.userId), {
          code: 'NOT_FOUND',
          message: 'Nameplate not found'
        });
      } else {
        invariant(false, {
          code: 'BAD_REQUEST',
          message: 'Invalid nameplate value'
        });
      }
    }

    await db
      .update(users)
      .set({ nameplate: input.nameplate, updatedAt: Date.now() })
      .where(eq(users.id, ctx.userId));

    publishUser(ctx.userId, 'update');

    // Push to peer instances holding a shadow user for me. Custom pack
    // ids are meaningless in a peer's id-space (and the image only lives
    // here), so peers see those as cleared rather than a colliding id.
    relayUserInfoUpdate(ctx.userId, {
      nameplate: input.nameplate?.startsWith('custom:')
        ? null
        : input.nameplate
    });
  });

export { setNameplateRoute };
