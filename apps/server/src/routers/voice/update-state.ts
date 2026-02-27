import { ChannelPermission, Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const updateVoiceStateRoute = protectedProcedure
  .input(
    z.object({
      micMuted: z.boolean().optional(),
      soundMuted: z.boolean().optional(),
      webcamEnabled: z.boolean().optional(),
      sharingScreen: z.boolean().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    invariant(ctx.currentVoiceChannelId, {
      code: 'BAD_REQUEST',
      message: 'User is not in a voice channel'
    });

    const validatedInput = { ...input };

    // Only enforce server channel permissions for non-DM voice
    if (!ctx.currentDmVoiceChannelId) {
      await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

      const [canSpeak, canUseWebcam, canShareScreen] = await Promise.all([
        ctx.hasChannelPermission(
          ctx.currentVoiceChannelId,
          ChannelPermission.SPEAK
        ),
        ctx.hasChannelPermission(
          ctx.currentVoiceChannelId,
          ChannelPermission.WEBCAM
        ),
        ctx.hasChannelPermission(
          ctx.currentVoiceChannelId,
          ChannelPermission.SHARE_SCREEN
        )
      ]);

      if (!canSpeak) {
        delete validatedInput.micMuted;
      }

      if (!canUseWebcam) {
        delete validatedInput.webcamEnabled;
      }

      if (!canShareScreen) {
        delete validatedInput.sharingScreen;
      }
    }

    const runtime = VoiceRuntime.findById(ctx.currentVoiceChannelId);

    invariant(runtime, {
      code: 'INTERNAL_SERVER_ERROR',
      message: `Voice runtime not found for channel ${ctx.currentVoiceChannelId}`
    });

    runtime.updateUserState(ctx.user.id, {
      ...validatedInput
    });

    const newState = runtime.getUserState(ctx.user.id);

    if (ctx.currentDmVoiceChannelId) {
      const { getDmChannelMemberIds } = await import('../../db/queries/dms');
      const dmMemberIds = await getDmChannelMemberIds(ctx.currentDmVoiceChannelId);
      ctx.pubsub.publishFor(dmMemberIds, ServerEvents.USER_VOICE_STATE_UPDATE, {
        channelId: ctx.currentVoiceChannelId,
        userId: ctx.user.id,
        state: newState
      });
    } else {
      const [ch] = await db
        .select({ serverId: channels.serverId })
        .from(channels)
        .where(eq(channels.id, ctx.currentVoiceChannelId))
        .limit(1);
      if (ch) {
        const memberIds = await getServerMemberIds(ch.serverId);
        ctx.pubsub.publishFor(memberIds, ServerEvents.USER_VOICE_STATE_UPDATE, {
          channelId: ctx.currentVoiceChannelId,
          userId: ctx.user.id,
          state: newState
        });
      }
    }
  });

export { updateVoiceStateRoute };
