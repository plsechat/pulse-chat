import { Permission } from '@pulse/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getProducersRoute = protectedProcedure.query(async ({ ctx }) => {
  if (!ctx.currentDmVoiceChannelId) {
    await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);
  }

  invariant(ctx.currentVoiceChannelId, {
    code: 'BAD_REQUEST',
    message: 'User is not in a voice channel'
  });

  const runtime = VoiceRuntime.findById(ctx.currentVoiceChannelId);

  invariant(runtime, {
    code: 'INTERNAL_SERVER_ERROR',
    message: `Voice runtime not found for channel ${ctx.currentVoiceChannelId}`
  });

  return runtime.getRemoteIds(ctx.user.id);
});

export { getProducersRoute };
