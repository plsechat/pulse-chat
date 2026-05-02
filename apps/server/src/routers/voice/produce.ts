import {
  ChannelPermission,
  getMediasoupKind,
  Permission,
  ServerEvents,
  StreamKind
} from '@pulse/shared';
import type { RtpParameters } from 'mediasoup/types';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

// Per-kind upper bound on encoding maxBitrate (bps).
// Mediasoup applies these as the ceiling the SFU is willing to accept;
// a malicious client cannot saturate the SFU by claiming an absurd bitrate.
// Tuned generously enough not to interfere with normal use.
const MAX_BITRATE_BY_KIND: Record<StreamKind, number> = {
  [StreamKind.AUDIO]: 510_000, // Opus stereo high-quality
  [StreamKind.VIDEO]: 3_000_000, // 3 Mbps comfortable HD camera
  [StreamKind.SCREEN]: 6_000_000, // 6 Mbps screen share
  [StreamKind.SCREEN_AUDIO]: 510_000,
  [StreamKind.EXTERNAL_VIDEO]: 3_000_000,
  [StreamKind.EXTERNAL_AUDIO]: 510_000
};

const MAX_FRAMERATE = 60;
const MAX_ENCODINGS = 3; // typical simulcast layer count
const MAX_CODECS = 8;
const MAX_HEADER_EXTENSIONS = 16;
const MAX_RTCP_FEEDBACK = 16;

// Use .passthrough() so we stay forward-compatible with mediasoup's RtpParameters
// shape (it adds fields), while still bounding the security-relevant ones.
const rtpEncodingSchema = z
  .object({
    ssrc: z.number().int().nonnegative().optional(),
    rid: z.string().max(64).optional(),
    codecPayloadType: z.number().int().nonnegative().optional(),
    rtx: z.object({ ssrc: z.number().int().nonnegative() }).optional(),
    dtx: z.boolean().optional(),
    scalabilityMode: z.string().max(32).optional(),
    scaleResolutionDownBy: z.number().positive().max(1024).optional(),
    maxBitrate: z.number().int().positive().optional(),
    maxFramerate: z.number().int().positive().max(MAX_FRAMERATE).optional()
  })
  .passthrough();

const rtpCodecSchema = z
  .object({
    mimeType: z.string().max(64),
    payloadType: z.number().int().nonnegative(),
    clockRate: z.number().int().positive().max(192_000),
    channels: z.number().int().positive().max(8).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    rtcpFeedback: z.array(z.unknown()).max(MAX_RTCP_FEEDBACK).optional()
  })
  .passthrough();

const rtpHeaderExtensionSchema = z
  .object({
    uri: z.string().max(128),
    id: z.number().int().nonnegative(),
    encrypt: z.boolean().optional(),
    parameters: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough();

const rtcpSchema = z
  .object({
    cname: z.string().max(64).optional(),
    reducedSize: z.boolean().optional()
  })
  .passthrough();

const rtpParametersSchema = z
  .object({
    mid: z.string().max(32).optional(),
    codecs: z.array(rtpCodecSchema).min(1).max(MAX_CODECS),
    headerExtensions: z
      .array(rtpHeaderExtensionSchema)
      .max(MAX_HEADER_EXTENSIONS)
      .optional(),
    encodings: z.array(rtpEncodingSchema).max(MAX_ENCODINGS).optional(),
    rtcp: rtcpSchema.optional()
  })
  .passthrough();

const produceInputSchema = z
  .object({
    transportId: z.string().max(128),
    kind: z.enum(StreamKind),
    rtpParameters: rtpParametersSchema
  })
  .superRefine((val, ctx) => {
    // Per-kind maxBitrate cap. Done as a refine so we have access to `kind`.
    const cap = MAX_BITRATE_BY_KIND[val.kind];
    for (const [i, enc] of (val.rtpParameters.encodings ?? []).entries()) {
      if (enc.maxBitrate !== undefined && enc.maxBitrate > cap) {
        ctx.addIssue({
          code: 'custom',
          path: ['rtpParameters', 'encodings', i, 'maxBitrate'],
          message: `maxBitrate ${enc.maxBitrate} exceeds ${cap} for kind ${val.kind}`
        });
      }
    }
  });

const produceRoute = protectedProcedure
  .input(produceInputSchema)
  .mutation(async ({ input, ctx }) => {
    invariant(ctx.currentVoiceChannelId, {
      code: 'BAD_REQUEST',
      message: 'User is not in a voice channel'
    });

    // Skip server permission checks for DM voice calls
    if (!ctx.currentDmVoiceChannelId) {
      await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

      if (input.kind === StreamKind.AUDIO) {
        await ctx.needsChannelPermission(
          ctx.currentVoiceChannelId,
          ChannelPermission.SPEAK
        );
      } else if (input.kind === StreamKind.VIDEO) {
        await ctx.needsChannelPermission(
          ctx.currentVoiceChannelId,
          ChannelPermission.WEBCAM
        );
      } else if (input.kind === StreamKind.SCREEN) {
        await ctx.needsChannelPermission(
          ctx.currentVoiceChannelId,
          ChannelPermission.SHARE_SCREEN
        );
      } else if (input.kind === StreamKind.SCREEN_AUDIO) {
        await ctx.needsChannelPermission(
          ctx.currentVoiceChannelId,
          ChannelPermission.SHARE_SCREEN
        );
      }
    }

    const runtime = VoiceRuntime.findById(ctx.currentVoiceChannelId);

    invariant(runtime, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Voice runtime not found for this channel'
    });

    const producerTransport = runtime.getProducerTransport(ctx.user.id);

    invariant(producerTransport, {
      code: 'NOT_FOUND',
      message: 'Producer transport not found'
    });

    const producer = await producerTransport.produce({
      kind: getMediasoupKind(input.kind),
      // Bounded by produceInputSchema above; mediasoup's RtpParameters has
      // strict subtypes that the .passthrough() schema doesn't fully express,
      // but the security-relevant numeric fields are bounded. Mediasoup will
      // reject a structurally invalid payload itself.
      rtpParameters: input.rtpParameters as RtpParameters,
      appData: { kind: input.kind, userId: ctx.user.id }
    });

    runtime.addProducer(ctx.user.id, input.kind, producer);

    ctx.pubsub.publishForChannel(
      ctx.currentVoiceChannelId,
      ServerEvents.VOICE_NEW_PRODUCER,
      {
        channelId: ctx.currentVoiceChannelId,
        remoteId: ctx.user.id,
        kind: input.kind
      }
    );

    return producer.id;
  });

export { produceRoute };
