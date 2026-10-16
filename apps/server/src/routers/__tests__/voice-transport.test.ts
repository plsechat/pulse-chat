import { ServerEvents, StreamKind } from '@pulse/shared';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { insertVoiceChannel } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';

// The WebRTC plumbing end to end against the real mediasoup worker the
// test preload loads: join → transports → connect → produce → consume →
// ICE restart → close → leave. The registry test covers only the
// in-memory registry; this one pins the routes' contract.

const OPUS_RTP_PARAMETERS = {
  codecs: [
    { mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2 }
  ],
  encodings: [{ ssrc: 41_000_001 }],
  rtcp: { cname: 'transport-test', reducedSize: true }
};

// A syntactically valid sha-256 fingerprint (the DTLS handshake itself
// never runs in a unit test; connect only records the parameters).
const FINGERPRINT =
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

const spyPublish = () => spyOn(pubsub, 'publishFor');
let publishSpy: ReturnType<typeof spyPublish> | undefined;

afterEach(() => {
  publishSpy?.mockRestore();
  publishSpy = undefined;
});

describe('voice transport lifecycle', () => {
  test('join publishes USER_JOIN_VOICE with kind "channel" and returns router capabilities', async () => {
    const channel = await insertVoiceChannel();
    const member = await initTest(2);
    const spy = spyPublish();
    publishSpy = spy;

    try {
      const result = await member.caller.voice.join({
        channelId: channel.id,
        state: { micMuted: true }
      });
      expect(result.routerRtpCapabilities.codecs?.length).toBeGreaterThan(0);
      expect(typeof result.startedAt).toBe('number');

      const join = spy.mock.calls.find(
        ([, topic]) => topic === ServerEvents.USER_JOIN_VOICE
      );
      expect(join?.[2]).toMatchObject({
        channelId: channel.id,
        kind: 'channel',
        userId: 2,
        state: { micMuted: true, serverMuted: false }
      });
      expect(member.ctx.currentVoiceChannelId).toBe(channel.id);
      expect(member.ctx.currentDmVoiceChannelId).toBeUndefined();
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('transports are refused before join', async () => {
    const member = await initTest(2);
    await expect(member.caller.voice.createProducerTransport()).rejects.toThrow(
      'User is not in a voice channel'
    );
    await expect(member.caller.voice.createConsumerTransport()).rejects.toThrow(
      'User is not in a voice channel'
    );
    await expect(member.caller.voice.getProducers()).rejects.toThrow(
      'User is not in a voice channel'
    );
  });

  test('createProducerTransport → connect (bad DTLS refused, double connect refused) → produce → getProducers', async () => {
    const channel = await insertVoiceChannel();
    const sender = await initTest(2);
    const receiver = await initTest(3);

    try {
      await sender.caller.voice.join({ channelId: channel.id, state: {} });
      const params = await sender.caller.voice.createProducerTransport();
      expect(params.id).toBeString();
      expect(params.iceParameters.iceLite).toBe(true);
      expect(params.dtlsParameters.fingerprints.length).toBeGreaterThan(0);

      // Unknown hash algorithm → rejected at the input boundary, never
      // handed to the worker.
      await expect(
        sender.caller.voice.connectProducerTransport({
          dtlsParameters: {
            role: 'client',
            fingerprints: [{ algorithm: 'md5' as 'sha-256', value: FINGERPRINT }]
          }
        })
      ).rejects.toThrow();

      await sender.caller.voice.connectProducerTransport({
        dtlsParameters: {
          role: 'client',
          fingerprints: [{ algorithm: 'sha-256', value: FINGERPRINT }]
        }
      });
      // mediasoup refuses a second connect on the same transport.
      await expect(
        sender.caller.voice.connectProducerTransport({
          dtlsParameters: {
            role: 'client',
            fingerprints: [{ algorithm: 'sha-256', value: FINGERPRINT }]
          }
        })
      ).rejects.toThrow();

      const producerId = await sender.caller.voice.produce({
        transportId: params.id,
        kind: StreamKind.AUDIO,
        rtpParameters: OPUS_RTP_PARAMETERS
      });
      expect(producerId).toBeString();

      await receiver.caller.voice.join({ channelId: channel.id, state: {} });
      const remote = await receiver.caller.voice.getProducers();
      expect(remote.remoteAudioIds).toEqual([2]);
      expect(remote.remoteVideoIds).toEqual([]);
      // Own producers are never listed back to their owner.
      const own = await sender.caller.voice.getProducers();
      expect(own.remoteAudioIds).toEqual([]);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('consume delivers a live consumer and VOICE_PRODUCER_CLOSED when the producer closes', async () => {
    const channel = await insertVoiceChannel();
    const sender = await initTest(2);
    const receiver = await initTest(3);

    try {
      const { routerRtpCapabilities } = await sender.caller.voice.join({
        channelId: channel.id,
        state: {}
      });
      const params = await sender.caller.voice.createProducerTransport();
      await sender.caller.voice.produce({
        transportId: params.id,
        kind: StreamKind.AUDIO,
        rtpParameters: OPUS_RTP_PARAMETERS
      });

      await receiver.caller.voice.join({ channelId: channel.id, state: {} });

      // No consumer transport yet → explicit NOT_FOUND, not a worker error.
      await expect(
        receiver.caller.voice.consume({
          kind: StreamKind.AUDIO,
          remoteId: 2,
          rtpCapabilities: routerRtpCapabilities
        })
      ).rejects.toThrow('Consumer transport not found');

      await receiver.caller.voice.createConsumerTransport();
      const consumed = await receiver.caller.voice.consume({
        kind: StreamKind.AUDIO,
        remoteId: 2,
        rtpCapabilities: routerRtpCapabilities
      });
      expect(consumed.consumerKind).toBe(StreamKind.AUDIO);
      expect(consumed.consumerRtpParameters.codecs[0]?.mimeType).toBe(
        'audio/opus'
      );

      const runtime = VoiceRuntime.findById(channel.id)!;
      expect(runtime.getConsumers(3)).toHaveLength(1);
      expect(runtime.getConsumers(3)[0]!.paused).toBe(false);

      // An unknown remote is NOT_FOUND.
      await expect(
        receiver.caller.voice.consume({
          kind: StreamKind.VIDEO,
          remoteId: 2,
          rtpCapabilities: routerRtpCapabilities
        })
      ).rejects.toThrow('Producer not found');

      // The producer-closed notification is room-scoped by runtime key.
      const received: unknown[] = [];
      const subscription = pubsub
        .subscribeForChannel(runtime.key, ServerEvents.VOICE_PRODUCER_CLOSED)
        .subscribe({ next: (event) => received.push(event) });

      try {
        await sender.caller.voice.closeProducer({ kind: StreamKind.AUDIO });
        expect(received).toContainEqual({
          channelId: channel.id,
          remoteId: 2,
          kind: StreamKind.AUDIO
        });
      } finally {
        subscription.unsubscribe();
      }
      expect(runtime.getProducer(StreamKind.AUDIO, 2)).toBeUndefined();
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('closeProducer only ever closes the caller\'s own producer', async () => {
    const channel = await insertVoiceChannel();
    const sender = await initTest(2);
    const other = await initTest(3);

    try {
      await sender.caller.voice.join({ channelId: channel.id, state: {} });
      const params = await sender.caller.voice.createProducerTransport();
      await sender.caller.voice.produce({
        transportId: params.id,
        kind: StreamKind.AUDIO,
        rtpParameters: OPUS_RTP_PARAMETERS
      });

      await other.caller.voice.join({ channelId: channel.id, state: {} });
      // User 3 has no audio producer: the call is refused and user 2's
      // producer is untouched — there is no way to name someone else's.
      await expect(
        other.caller.voice.closeProducer({ kind: StreamKind.AUDIO })
      ).rejects.toThrow('Producer for audio not found');

      const runtime = VoiceRuntime.findById(channel.id)!;
      expect(runtime.getProducer(StreamKind.AUDIO, 2)?.closed).toBe(false);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('restartIce issues fresh ICE parameters for the named transport', async () => {
    const channel = await insertVoiceChannel();
    const member = await initTest(2);

    try {
      await member.caller.voice.join({ channelId: channel.id, state: {} });
      const params = await member.caller.voice.createProducerTransport();

      const restarted = await member.caller.voice.restartIce({
        type: 'producer'
      });
      expect(restarted?.iceParameters.usernameFragment).toBeString();
      expect(restarted?.iceParameters.usernameFragment).not.toBe(
        params.iceParameters.usernameFragment
      );

      // No consumer transport yet.
      await expect(
        member.caller.voice.restartIce({ type: 'consumer' })
      ).rejects.toThrow('Transport not found');
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('leave tears the runtime down once the room is empty', async () => {
    const channel = await insertVoiceChannel();
    const first = await initTest(2);
    const second = await initTest(3);
    const spy = spyPublish();
    publishSpy = spy;

    try {
      await first.caller.voice.join({ channelId: channel.id, state: {} });
      await first.caller.voice.createProducerTransport();
      await second.caller.voice.join({ channelId: channel.id, state: {} });

      await first.caller.voice.leave();
      const runtime = VoiceRuntime.findById(channel.id);
      expect(runtime).toBeDefined();
      expect(runtime!.getUser(2)).toBeUndefined();
      expect(runtime!.getProducerTransport(2)).toBeUndefined();
      expect(first.ctx.currentVoiceChannelId).toBeUndefined();

      const leave = spy.mock.calls.find(
        ([, topic]) => topic === ServerEvents.USER_LEAVE_VOICE
      );
      expect(leave?.[2]).toMatchObject({
        channelId: channel.id,
        kind: 'channel',
        userId: 2
      });

      await second.caller.voice.leave();
      expect(VoiceRuntime.findById(channel.id)).toBeUndefined();
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('a DM call and a server channel with the same id keep their producer events apart', async () => {
    // Force an id collision: the DM runtime is staged directly on the
    // server channel's numeric id. Room events for the server channel
    // must not reach a subscriber of the DM room and vice versa.
    const channel = await insertVoiceChannel();
    const sender = await initTest(2);
    const dmRuntime = new VoiceRuntime(channel.id, true);

    try {
      await sender.caller.voice.join({ channelId: channel.id, state: {} });
      const params = await sender.caller.voice.createProducerTransport();

      const dmReceived: unknown[] = [];
      const channelReceived: unknown[] = [];
      const dmSub = pubsub
        .subscribeForChannel(dmRuntime.key, ServerEvents.VOICE_NEW_PRODUCER)
        .subscribe({ next: (e) => dmReceived.push(e) });
      const channelSub = pubsub
        .subscribeForChannel(`channel:${channel.id}`, ServerEvents.VOICE_NEW_PRODUCER)
        .subscribe({ next: (e) => channelReceived.push(e) });

      try {
        await sender.caller.voice.produce({
          transportId: params.id,
          kind: StreamKind.AUDIO,
          rtpParameters: OPUS_RTP_PARAMETERS
        });
        expect(channelReceived).toHaveLength(1);
        expect(dmReceived).toHaveLength(0);
      } finally {
        dmSub.unsubscribe();
        channelSub.unsubscribe();
      }
    } finally {
      await dmRuntime.destroy();
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });
});
