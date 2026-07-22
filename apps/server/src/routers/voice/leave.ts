import { Permission } from '@pulse/shared';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { removeUserFromVoice } from '../../utils/voice-cleanup';

const leaveVoiceRoute = protectedProcedure.mutation(async ({ ctx }) => {
  await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

  // Fall back to the runtime lookup when the per-connection context has
  // no channel — after a refresh the new connection never joined, but
  // the user's stale session may still be in a runtime and they must be
  // able to remove themselves from it.
  const runtime = ctx.currentVoiceChannelId
    ? VoiceRuntime.findById(
        ctx.currentVoiceChannelId,
        ctx.currentDmVoiceChannelId !== undefined ? 'dm' : 'channel'
      )
    : VoiceRuntime.findRuntimeByUserId(ctx.user.id);

  invariant(runtime && runtime.getUser(ctx.user.id), {
    code: 'BAD_REQUEST',
    message: 'User is not in a voice channel'
  });

  const channelId = runtime.id;

  await removeUserFromVoice(ctx.user.id);

  ctx.currentVoiceChannelId = undefined;
  ctx.currentDmVoiceChannelId = undefined;
  ctx.setWsVoiceKey(undefined);

  logger.info('%s left voice channel %d', ctx.user.name, channelId);
});

export { leaveVoiceRoute };
