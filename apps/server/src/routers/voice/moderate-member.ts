import { Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels } from '../../db/schema';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

/**
 * Moderator server-mute / server-deafen of a member in a voice channel of
 * the active server. Gated on MANAGE_USERS (same as kick/ban/disconnect).
 * DM calls are excluded. serverMuted additionally pauses the target's
 * audio producer at the SFU so the mute is enforced, not advisory.
 */
const moderateMemberRoute = serverProcedure(Permission.MANAGE_USERS)
  .input(
    z.object({
      userId: z.number(),
      serverMuted: z.boolean().optional(),
      serverDeafened: z.boolean().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    invariant(
      input.serverMuted !== undefined || input.serverDeafened !== undefined,
      { code: 'BAD_REQUEST', message: 'No moderation change specified' }
    );

    const runtime = VoiceRuntime.findRuntimeByUserId(input.userId);

    invariant(runtime && !runtime.isDmVoice, {
      code: 'BAD_REQUEST',
      message: 'User is not in a voice channel'
    });

    // Cross-server scope: the target's channel must belong to the
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

    const patch: { serverMuted?: boolean; serverDeafened?: boolean } = {};
    if (input.serverMuted !== undefined) patch.serverMuted = input.serverMuted;
    if (input.serverDeafened !== undefined) {
      patch.serverDeafened = input.serverDeafened;
    }

    runtime.updateUserState(input.userId, patch);

    if (input.serverMuted !== undefined) {
      await runtime.setAudioPaused(input.userId, input.serverMuted);
    }

    const newState = runtime.getUserState(input.userId);
    const memberIds = await getServerMemberIds(ch.serverId);
    ctx.pubsub.publishFor(memberIds, ServerEvents.USER_VOICE_STATE_UPDATE, {
      channelId: runtime.id,
      userId: input.userId,
      state: newState
    });

    logger.info(
      '%s set voice moderation on user %d (muted=%s deafened=%s)',
      ctx.user.name,
      input.userId,
      String(input.serverMuted),
      String(input.serverDeafened)
    );
  });

export { moderateMemberRoute };
