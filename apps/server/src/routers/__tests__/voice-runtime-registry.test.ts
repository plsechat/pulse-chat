import { describe, expect, test } from 'bun:test';
import { VoiceRuntime } from '../../runtimes/voice';

// Server voice channels and DM calls draw ids from independent serial
// sequences (channels.id vs dmChannels.id), so one numeric id can name
// BOTH at once. The registry keys entries by kind ("channel:5" / "dm:5");
// these tests pin the collision semantics. Regression guard: a bare
// numeric key let a DM call overwrite — or resolve to — a live server
// channel's runtime, routing users into the wrong mediasoup router.
//
// Runtimes are pure in-memory state (no mediasoup init on construction)
// and the module-level registry is NOT reset by the between-test
// TRUNCATE, so every test destroys what it creates.

describe('VoiceRuntime registry keyspaces', () => {
  test('a DM call and a server channel with the same id coexist', async () => {
    const channelRuntime = new VoiceRuntime(9001);
    const dmRuntime = new VoiceRuntime(9001, true);

    try {
      expect(VoiceRuntime.findById(9001)).toBe(channelRuntime);
      expect(VoiceRuntime.findById(9001, 'channel')).toBe(channelRuntime);
      expect(VoiceRuntime.findById(9001, 'dm')).toBe(dmRuntime);
      expect(channelRuntime.key).toBe('channel:9001');
      expect(dmRuntime.key).toBe('dm:9001');
    } finally {
      await channelRuntime.destroy();
      await dmRuntime.destroy();
    }
  });

  test('destroying one keyspace entry leaves the other intact', async () => {
    const channelRuntime = new VoiceRuntime(9002);
    const dmRuntime = new VoiceRuntime(9002, true);

    try {
      await dmRuntime.destroy();
      expect(VoiceRuntime.findById(9002, 'dm')).toBeUndefined();
      expect(VoiceRuntime.findById(9002, 'channel')).toBe(channelRuntime);
    } finally {
      await channelRuntime.destroy();
    }
  });

  test('server voice maps exclude DM calls even on id collision', async () => {
    const channelRuntime = new VoiceRuntime(9003);
    const dmRuntime = new VoiceRuntime(9003, true);

    try {
      channelRuntime.addUser(101, { micMuted: false, soundMuted: false });
      dmRuntime.addUser(202, { micMuted: false, soundMuted: false });

      const map = VoiceRuntime.getVoiceMap(new Set([9003]));
      expect(map[9003]).toBeDefined();
      expect(map[9003]!.users[101]).toBeDefined();
      // The DM participant must NOT leak into the server-channel map.
      expect(map[9003]!.users[202]).toBeUndefined();

      const streams = VoiceRuntime.getExternalStreamsMap(new Set([9003]));
      expect(streams[9003]).toBeDefined();
    } finally {
      await channelRuntime.destroy();
      await dmRuntime.destroy();
    }
  });

  test('requireByCtx resolves the keyspace from the DM-call marker', async () => {
    const channelRuntime = new VoiceRuntime(9004);
    const dmRuntime = new VoiceRuntime(9004, true);

    try {
      expect(
        VoiceRuntime.requireByCtx({
          currentVoiceChannelId: 9004,
          currentDmVoiceChannelId: undefined
        })
      ).toBe(channelRuntime);
      expect(
        VoiceRuntime.requireByCtx({
          currentVoiceChannelId: 9004,
          currentDmVoiceChannelId: 9004
        })
      ).toBe(dmRuntime);
    } finally {
      await channelRuntime.destroy();
      await dmRuntime.destroy();
    }
  });
});
