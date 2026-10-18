import { z } from 'zod';

/**
 * Bounded zod schemas for the mediasoup-shaped payloads voice routes
 * accept from clients. Everything here is parsed and validated by the
 * mediasoup worker on the single Bun thread, so each one is a DoS lever
 * unless it is bounded before it reaches the worker. The schemas use
 * `.passthrough()` to stay forward-compatible with mediasoup adding
 * fields, while capping the security-relevant ones.
 */

const MAX_CODECS = 8;
const MAX_HEADER_EXTENSIONS = 16;
const MAX_RTCP_FEEDBACK = 16;
const MAX_CAPABILITY_CODECS = 32;
const MAX_CAPABILITY_HEADER_EXTENSIONS = 32;
const MAX_FEC_MECHANISMS = 8;
const MAX_DTLS_FINGERPRINTS = 8;

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

// RtpCodecCapability (what a browser can receive) — unlike the codec
// *parameters* above it carries `preferredPayloadType` and `kind`.
const rtpCodecCapabilitySchema = z
  .object({
    kind: z.enum(['audio', 'video']),
    mimeType: z.string().max(64),
    preferredPayloadType: z.number().int().nonnegative().optional(),
    clockRate: z.number().int().positive().max(192_000),
    channels: z.number().int().positive().max(8).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    rtcpFeedback: z.array(z.unknown()).max(MAX_RTCP_FEEDBACK).optional()
  })
  .passthrough();

const rtpHeaderExtensionCapabilitySchema = z
  .object({
    kind: z.enum(['audio', 'video']).optional(),
    uri: z.string().max(128),
    preferredId: z.number().int().nonnegative(),
    preferredEncrypt: z.boolean().optional(),
    direction: z
      .enum(['sendrecv', 'sendonly', 'recvonly', 'inactive'])
      .optional()
  })
  .passthrough();

/** RtpCapabilities as sent by mediasoup-client `device.rtpCapabilities`. */
const rtpCapabilitiesSchema = z
  .object({
    codecs: z.array(rtpCodecCapabilitySchema).max(MAX_CAPABILITY_CODECS).optional(),
    headerExtensions: z
      .array(rtpHeaderExtensionCapabilitySchema)
      .max(MAX_CAPABILITY_HEADER_EXTENSIONS)
      .optional(),
    fecMechanisms: z.array(z.string().max(32)).max(MAX_FEC_MECHANISMS).optional()
  })
  .passthrough();

/** DtlsParameters as sent by mediasoup-client on transport `connect`. */
const dtlsParametersSchema = z
  .object({
    role: z.enum(['auto', 'client', 'server']).optional(),
    fingerprints: z
      .array(
        z.object({
          algorithm: z.enum(['sha-1', 'sha-224', 'sha-256', 'sha-384', 'sha-512']),
          value: z.string().max(128)
        })
      )
      .min(1)
      .max(MAX_DTLS_FINGERPRINTS)
  })
  .passthrough();

export {
  dtlsParametersSchema,
  MAX_CODECS,
  MAX_HEADER_EXTENSIONS,
  rtpCapabilitiesSchema,
  rtpCodecSchema,
  rtpHeaderExtensionSchema
};
