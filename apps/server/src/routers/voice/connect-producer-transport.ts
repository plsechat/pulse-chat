import { Permission } from '@pulse/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { dtlsParametersSchema } from './schemas';

const connectProducerTransportRoute = protectedProcedure
  .input(
    z.object({
      dtlsParameters: dtlsParametersSchema
    })
  )
  .mutation(async ({ input, ctx }) => {
    if (!ctx.currentDmVoiceChannelId) {
      await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);
    }

    invariant(ctx.currentVoiceChannelId, {
      code: 'BAD_REQUEST',
      message: 'User is not in a voice channel'
    });

    const runtime = VoiceRuntime.requireByCtx(ctx);

    const producerTransport = runtime.getProducerTransport(ctx.user.id);

    invariant(producerTransport, {
      code: 'NOT_FOUND',
      message: 'Producer transport not found'
    });

    await producerTransport.connect({ dtlsParameters: input.dtlsParameters });
  });

export { connectProducerTransportRoute };
