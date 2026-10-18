import { describe, expect, test } from 'bun:test';
import { insertVoiceChannel, stageUserInVoice } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { config } from '../../config';
import { VoiceRuntime } from '../../runtimes/voice';
import { getWebRtcServer } from '../../utils/mediasoup';

// Media networking modes and the instance-wide participant cap.
//
// Single-port (default): one WebRtcServer binds the media port for UDP
// and TCP and every transport multiplexes over it — the old 21-port
// range capped the whole instance at ~10 participants and failed with an
// opaque INTERNAL_SERVER_ERROR. Range mode is kept for operators whose
// network depends on per-transport ports; its exhaustion maps to the
// same PRECONDITION_FAILED the cap raises.
//
// The mocked config is a plain object: tests flip keys and restore them.

const workerConfig = config.mediasoup.worker;

describe('single-port mode', () => {
  test('the WebRtcServer is bound and transports advertise its port', async () => {
    expect(getWebRtcServer()).toBeDefined();

    const channel = await insertVoiceChannel();
    const runtime = new VoiceRuntime(channel.id);
    await runtime.init();

    try {
      const { transport, params } = await runtime.createTransport();
      try {
        const ports = new Set(params.iceCandidates.map((c) => c.port));
        expect([...ports]).toEqual([workerConfig.port]);
        const protocols = params.iceCandidates.map((c) => c.protocol).sort();
        expect(protocols).toEqual(['tcp', 'udp']);
      } finally {
        transport.close();
      }
    } finally {
      await runtime.destroy();
    }
  });

  test('creates far more transports than the old port range allowed', async () => {
    const channel = await insertVoiceChannel();
    const runtime = new VoiceRuntime(channel.id);
    await runtime.init();

    try {
      // 26 transports = 13 participants' worth; the 21-port range held 10.
      for (let userId = 1000; userId < 1026; userId++) {
        await runtime.createProducerTransport(userId);
      }
      for (let userId = 1000; userId < 1026; userId++) {
        expect(runtime.getProducerTransport(userId)).toBeDefined();
      }
    } finally {
      await runtime.destroy();
    }
  });
});

describe('range mode', () => {
  test('port exhaustion maps to PRECONDITION_FAILED "Voice capacity reached"', async () => {
    const original = { ...workerConfig };
    // Two ports, well away from the single-port socket and the default
    // range, so a parallel suite on this machine cannot collide.
    workerConfig.mode = 'range';
    workerConfig.rtcMinPort = original.port + 100;
    workerConfig.rtcMaxPort = original.port + 101;

    const channel = await insertVoiceChannel();
    const runtime = new VoiceRuntime(channel.id);
    await runtime.init();

    try {
      // Each transport binds one UDP and one TCP port (separate pools,
      // each drawn from the range independently).
      const first = await runtime.createProducerTransport(2001);
      const second = await runtime.createProducerTransport(2002);
      const inRange = (port: number) =>
        port >= workerConfig.rtcMinPort && port <= workerConfig.rtcMaxPort;
      for (const params of [first, second]) {
        expect(params.iceCandidates).toHaveLength(2);
        expect(params.iceCandidates.every((c) => inRange(c.port))).toBe(true);
      }
      // Two transports exhaust both pools: the UDP ports differ, as do the TCP ones.
      const udp = (p: typeof first) =>
        p.iceCandidates.find((c) => c.protocol === 'udp')!.port;
      expect(udp(first)).not.toBe(udp(second));

      await expect(runtime.createProducerTransport(2003)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Voice capacity reached'
      });

      // Closing a transport frees its ports for the next participant.
      runtime.removeProducerTransport(2001);
      await runtime.createProducerTransport(2004);
      expect(runtime.getProducerTransport(2004)).toBeDefined();
    } finally {
      await runtime.destroy();
      Object.assign(workerConfig, original);
    }
  });
});

describe('instance-wide participant cap (maxParticipants)', () => {
  test('voice.join refuses the (cap+1)th participant across rooms; 0 means unlimited', async () => {
    const originalCap = config.mediasoup.maxParticipants;
    const channelA = await insertVoiceChannel();
    const channelB = await insertVoiceChannel();
    const first = await initTest(2);
    const second = await initTest(3);

    try {
      config.mediasoup.maxParticipants = 1;

      await first.caller.voice.join({ channelId: channelA.id, state: {} });
      // The cap counts the whole instance, not the room.
      await expect(
        second.caller.voice.join({ channelId: channelB.id, state: {} })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Voice capacity reached'
      });
      expect(VoiceRuntime.findRuntimeByUserId(3)).toBeUndefined();
      // A refused join leaves no empty room behind.
      expect(VoiceRuntime.findById(channelB.id)).toBeUndefined();

      config.mediasoup.maxParticipants = 0;
      await second.caller.voice.join({ channelId: channelB.id, state: {} });
      expect(VoiceRuntime.findRuntimeByUserId(3)?.id).toBe(channelB.id);
    } finally {
      config.mediasoup.maxParticipants = originalCap;
      await VoiceRuntime.findById(channelA.id)?.destroy();
      await VoiceRuntime.findById(channelB.id)?.destroy();
    }
  });

  test('a rejoin at capacity (refresh self-heal) is not refused', async () => {
    const originalCap = config.mediasoup.maxParticipants;
    const channel = await insertVoiceChannel();
    const first = await initTest(2);

    try {
      config.mediasoup.maxParticipants = 1;
      await first.caller.voice.join({ channelId: channel.id, state: {} });

      // Same user, new connection: the stale session is removed first,
      // so the participant count the cap sees is 0 again.
      const second = await initTest(2);
      await second.caller.voice.join({ channelId: channel.id, state: {} });
      expect(VoiceRuntime.findById(channel.id)?.getState().users).toHaveLength(1);
    } finally {
      config.mediasoup.maxParticipants = originalCap;
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('dms.voiceJoin honours the same cap', async () => {
    const originalCap = config.mediasoup.maxParticipants;
    const { caller: caller1 } = await initTest(1);
    const dm = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const channel = await insertVoiceChannel();
    const member = await initTest(2);

    try {
      config.mediasoup.maxParticipants = 1;
      // A server-channel participant fills the instance.
      stageUserInVoice(channel.id, 3);

      await expect(
        member.caller.dms.voiceJoin({ dmChannelId: dm.id, state: {} })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Voice capacity reached'
      });
      expect(VoiceRuntime.findById(dm.id, 'dm')).toBeUndefined();
    } finally {
      config.mediasoup.maxParticipants = originalCap;
      await VoiceRuntime.findById(channel.id)?.destroy();
      await VoiceRuntime.findById(dm.id, 'dm')?.destroy();
    }
  });
});
