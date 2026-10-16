import { describe, expect, test } from 'bun:test';
import { StreamKind } from '@pulse/shared';
import { initTest } from '../../__tests__/helpers';
import { dtlsParametersSchema, rtpCapabilitiesSchema } from '../voice/schemas';

/**
 * Browser-shaped payloads, as mediasoup-client hands them to the
 * transport `connect` / `consume` signalling (Chrome 128, trimmed to
 * the codecs that matter). These must keep passing: a tightened schema
 * that rejects a real client breaks every call.
 */
const chromeDtlsParameters = {
  role: 'client' as const,
  fingerprints: [
    {
      algorithm: 'sha-256',
      value:
        '7B:0A:4F:2C:9D:11:6E:3A:52:E8:C1:0F:9B:7D:33:4A:5C:21:DE:88:F0:1B:6C:77:AE:90:12:3D:45:67:89:AB'
    }
  ]
};

const chromeRtpCapabilities = {
  codecs: [
    {
      kind: 'audio' as const,
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
      preferredPayloadType: 100,
      parameters: { minptime: 10, useinbandfec: 1 },
      rtcpFeedback: [{ type: 'transport-cc', parameter: '' }]
    },
    {
      kind: 'video' as const,
      mimeType: 'video/H264',
      clockRate: 90000,
      preferredPayloadType: 101,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f',
        'level-asymmetry-allowed': 1
      },
      rtcpFeedback: [
        { type: 'nack', parameter: '' },
        { type: 'nack', parameter: 'pli' },
        { type: 'ccm', parameter: 'fir' },
        { type: 'goog-remb', parameter: '' },
        { type: 'transport-cc', parameter: '' }
      ]
    },
    {
      kind: 'video' as const,
      mimeType: 'video/rtx',
      clockRate: 90000,
      preferredPayloadType: 102,
      parameters: { apt: 101 },
      rtcpFeedback: []
    }
  ],
  headerExtensions: [
    {
      kind: 'audio' as const,
      uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
      preferredId: 1,
      preferredEncrypt: false,
      direction: 'sendrecv' as const
    },
    {
      kind: 'video' as const,
      uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
      preferredId: 4,
      preferredEncrypt: false,
      direction: 'sendrecv' as const
    },
    {
      kind: 'video' as const,
      uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
      preferredId: 5,
      preferredEncrypt: false,
      direction: 'sendrecv' as const
    }
  ],
  fecMechanisms: []
};

describe('voice schemas', () => {
  test('a real browser dtlsParameters payload passes', () => {
    expect(dtlsParametersSchema.safeParse(chromeDtlsParameters).success).toBe(
      true
    );
  });

  test('a real browser rtpCapabilities payload passes', () => {
    expect(
      rtpCapabilitiesSchema.safeParse(chromeRtpCapabilities).success
    ).toBe(true);
  });

  test('dtlsParameters: unknown algorithm, oversize value, too many fingerprints, none', () => {
    const fp = chromeDtlsParameters.fingerprints[0]!;
    expect(
      dtlsParametersSchema.safeParse({
        fingerprints: [{ ...fp, algorithm: 'md5' }]
      }).success
    ).toBe(false);
    expect(
      dtlsParametersSchema.safeParse({
        fingerprints: [{ ...fp, value: 'x'.repeat(129) }]
      }).success
    ).toBe(false);
    expect(
      dtlsParametersSchema.safeParse({
        fingerprints: Array.from({ length: 9 }, () => fp)
      }).success
    ).toBe(false);
    expect(dtlsParametersSchema.safeParse({ fingerprints: [] }).success).toBe(
      false
    );
    expect(dtlsParametersSchema.safeParse('garbage').success).toBe(false);
  });

  test('rtpCapabilities: too many codecs/extensions, oversize mimeType, bad kind', () => {
    const codec = chromeRtpCapabilities.codecs[0]!;
    expect(
      rtpCapabilitiesSchema.safeParse({
        codecs: Array.from({ length: 33 }, () => codec)
      }).success
    ).toBe(false);
    expect(
      rtpCapabilitiesSchema.safeParse({
        codecs: [{ ...codec, mimeType: 'audio/' + 'x'.repeat(64) }]
      }).success
    ).toBe(false);
    expect(
      rtpCapabilitiesSchema.safeParse({
        codecs: [{ ...codec, kind: 'data' }]
      }).success
    ).toBe(false);
    expect(
      rtpCapabilitiesSchema.safeParse({
        headerExtensions: Array.from(
          { length: 33 },
          () => chromeRtpCapabilities.headerExtensions[0]
        )
      }).success
    ).toBe(false);
    expect(
      rtpCapabilitiesSchema.safeParse({
        fecMechanisms: Array.from({ length: 9 }, () => 'red')
      }).success
    ).toBe(false);
  });
});

describe('voice routes reject unbounded payloads before touching the SFU', () => {
  test('consume: oversize rtpCapabilities and a non-integer remoteId are BAD_REQUEST', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.voice.consume({
        kind: StreamKind.AUDIO,
        remoteId: 2,
        rtpCapabilities: {
          codecs: Array.from({ length: 33 }, () => chromeRtpCapabilities.codecs[0]!)
        }
      })
    ).rejects.toThrow();

    await expect(
      caller.voice.consume({
        kind: StreamKind.AUDIO,
        remoteId: 1.5,
        rtpCapabilities: chromeRtpCapabilities
      })
    ).rejects.toThrow();
  });

  test('connect*Transport: malformed dtlsParameters are BAD_REQUEST', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.voice.connectProducerTransport({
        dtlsParameters: { fingerprints: [] }
      })
    ).rejects.toThrow();
    await expect(
      caller.voice.connectConsumerTransport({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dtlsParameters: 'x'.repeat(100_000) as any
      })
    ).rejects.toThrow();
  });

  test('ids must be positive integers on join, disconnectUser and moderateMember', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.voice.join({ channelId: 0, state: {} })
    ).rejects.toThrow();
    await expect(
      caller.voice.disconnectUser({ userId: 2.5 })
    ).rejects.toThrow();
    await expect(
      caller.voice.moderateMember({ userId: -1, serverMuted: true })
    ).rejects.toThrow();
  });
});
