import { Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { removeUserFromVoice } from '../../utils/voice-cleanup';

/**
 * Moderator action: force-remove a user from a voice channel of the
 * active server. Rides the same MANAGE_USERS permission as kick/ban.
 * DM calls are deliberately excluded — there is no moderation concept
 * in DMs.
 */
const disconnectUserRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_USERS);

    invariant(input.userId !== ctx.user.id, {
      code: 'BAD_REQUEST',
      message: 'Use leave to disconnect yourself'
    });

    const runtime = VoiceRuntime.findRuntimeByUserId(input.userId);

    invariant(runtime && !runtime.isDmVoice, {
      code: 'BAD_REQUEST',
      message: 'User is not in a voice channel'
    });

    // Cross-server scope: the target's voice channel must belong to the
    // invoker's active server. Same opaque message as not-in-voice so a
    // moderator can't probe other servers' voice occupancy.
    const [ch] = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, runtime.id))
      .limit(1);

    invariant(ch && ch.serverId === ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'User is not in a voice channel'
    });

    await removeUserFromVoice(input.userId);

    logger.info(
      '%s disconnected user %d from voice channel %d',
      ctx.user.name,
      input.userId,
      runtime.id
    );
  });

export { disconnectUserRoute };
