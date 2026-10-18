import { Permission, ServerEvents, StreamKind } from '@pulse/shared';
import type { RtpCapabilities } from 'mediasoup/types';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { rtpCapabilitiesSchema } from './schemas';

const consumer_kind_is_audio = (kind: 'audio' | 'video') => kind === 'audio';

const consumeRoute = protectedProcedure
  .input(
    z.object({
      kind: z.enum(StreamKind),
      remoteId: z.number().int().positive(),
      rtpCapabilities: rtpCapabilitiesSchema
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

    const producer = runtime.getProducer(input.kind, input.remoteId);

    invariant(producer, {
      code: 'NOT_FOUND',
      message: 'Producer not found'
    });

    const userConsumerTransport = runtime.getConsumerTransport(ctx.user.id);

    invariant(userConsumerTransport, {
      code: 'NOT_FOUND',
      message: 'Consumer transport not found'
    });

    const router = runtime.getRouter();
    const routerCanConsume = router.canConsume({
      producerId: producer.id,
      rtpCapabilities: input.rtpCapabilities as RtpCapabilities
    });

    invariant(routerCanConsume, {
      code: 'BAD_REQUEST',
      message: 'Cannot consume this producer with the given RTP capabilities'
    });

    // A server-deafened user must not receive audio: the consumer is
    // born paused at the SFU and resumed only when a moderator lifts
    // the override (runtime.setConsumersPaused).
    const consumer = await userConsumerTransport.consume({
      producerId: producer.id,
      rtpCapabilities: input.rtpCapabilities as RtpCapabilities,
      paused:
        consumer_kind_is_audio(producer.kind) &&
        runtime.getUserState(ctx.user.id).serverDeafened
    });

    runtime.addConsumer(ctx.user.id, consumer);

    // The room key is captured now: the handler fires later, when this
    // connection's markers may already point elsewhere.
    const { key: runtimeKey, id: runtimeId } = runtime;

    consumer.on('producerclose', () => {
      ctx.pubsub.publishForChannel(
        runtimeKey,
        ServerEvents.VOICE_PRODUCER_CLOSED,
        {
          channelId: runtimeId,
          remoteId: input.remoteId,
          kind: input.kind
        }
      );
    });

    return {
      producerId: producer.id,
      consumerId: consumer.id,
      consumerKind: input.kind,
      consumerRtpParameters: consumer.rtpParameters,
      consumerType: consumer.type
    };
  });

export { consumeRoute };
