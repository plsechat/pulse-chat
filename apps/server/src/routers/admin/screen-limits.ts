import {
  DEFAULT_SCREEN_MAX_FRAMERATE,
  DEFAULT_SCREEN_MAX_RESOLUTION,
  SCREEN_FRAMERATES,
  SCREEN_RESOLUTIONS
} from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { settings } from '../../db/schema';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Instance-global screen-share quality ceiling on the single-row settings
 * table. The client offers every resolution/framerate rung at or below
 * these and clamps its capture to them. Resolution is never visible to the
 * SFU (it only relays RTP), so this is a client-honored policy default, not
 * a hard wire limit — framerate additionally has a fixed 60 fps server cap.
 */
const getScreenLimitsRoute = instanceOwnerProcedure.query(async () => {
  const [row] = await db
    .select({
      maxResolution: settings.screenMaxResolution,
      maxFramerate: settings.screenMaxFramerate
    })
    .from(settings)
    .limit(1);

  return {
    maxResolution: row?.maxResolution ?? DEFAULT_SCREEN_MAX_RESOLUTION,
    maxFramerate: row?.maxFramerate ?? DEFAULT_SCREEN_MAX_FRAMERATE
  };
});

const setScreenLimitsRoute = instanceOwnerProcedure
  .input(
    z.object({
      maxResolution: z.enum(SCREEN_RESOLUTIONS),
      maxFramerate: z
        .number()
        .int()
        .refine((f) => (SCREEN_FRAMERATES as readonly number[]).includes(f), {
          message: 'Unsupported framerate'
        })
    })
  )
  .mutation(async ({ input }) => {
    // No `where`: settings is a singleton, matching the registration route.
    await db.update(settings).set({
      screenMaxResolution: input.maxResolution,
      screenMaxFramerate: input.maxFramerate
    });
  });

export { getScreenLimitsRoute, setScreenLimitsRoute };
