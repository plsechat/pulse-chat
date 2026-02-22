import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

const restartIceRoute = protectedProcedure
  .input(
    z.object({
      type: z.enum(['producer', 'consumer'])
    })
  )
  .mutation(async ({ input, ctx }) => {
    const runtime = VoiceRuntime.findRuntimeByUserId(ctx.userId);

    if (!runtime) {
      ctx.throwValidationError('type', 'Not in a voice channel');
      return;
    }

    const transport =
      input.type === 'producer'
        ? runtime.getProducerTransport(ctx.userId)
        : runtime.getConsumerTransport(ctx.userId);

    if (!transport) {
      ctx.throwValidationError('type', 'Transport not found');
      return;
    }

    const iceParameters = await transport.restartIce();

    return { iceParameters };
  });

export { restartIceRoute };
