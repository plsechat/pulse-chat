import { Permission } from '@pulse/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const createProducerTransportRoute = protectedProcedure.mutation(
  async ({ ctx }) => {
    if (!ctx.currentDmVoiceChannelId) {
      await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);
    }

    invariant(ctx.currentVoiceChannelId, {
      code: 'BAD_REQUEST',
      message: 'User is not in a voice channel'
    });

    const runtime = VoiceRuntime.requireById(ctx.currentVoiceChannelId);

    const params = await runtime.createProducerTransport(ctx.user.id);

    return params;
  }
);

export { createProducerTransportRoute };
