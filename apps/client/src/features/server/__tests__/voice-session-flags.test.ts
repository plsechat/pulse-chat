/**
 * ownVoiceState per-session flag reset on voice leave.
 *
 * The SFU seeds every join from its defaults (webcam off, no screen share,
 * no moderator overrides), so the client must forget those flags whenever it
 * leaves a call — otherwise the sidebar share/camera buttons stay lit with
 * nothing flowing after a disconnect → reconnect, and the first click only
 * "stops" a share that does not exist.
 *
 * Run via:
 *   bun test apps/client/src/features/server/__tests__/voice-session-flags.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { serverSliceActions, serverSliceReducer as reducer } from '../slice';
const initial = reducer(undefined, { type: '@@init' });

const inCallSharing = () => {
  let s = reducer(initial, serverSliceActions.setCurrentVoiceChannelId(7));
  s = reducer(
    s,
    serverSliceActions.updateOwnVoiceState({
      micMuted: true,
      soundMuted: true,
      webcamEnabled: true,
      sharingScreen: true,
      serverMuted: true,
      serverDeafened: true
    })
  );
  return s;
};

describe('ownVoiceState session flags', () => {
  test('leaving voice clears webcam, screen share and moderator overrides', () => {
    const s = reducer(
      inCallSharing(),
      serverSliceActions.setCurrentVoiceChannelId(undefined)
    );
    expect(s.currentVoiceChannelId).toBeUndefined();
    expect(s.ownVoiceState).toEqual({
      micMuted: true,
      soundMuted: true,
      webcamEnabled: false,
      sharingScreen: false,
      serverMuted: false,
      serverDeafened: false
    });
  });

  test('switching channels keeps the flags (provider owns that teardown)', () => {
    const s = reducer(
      inCallSharing(),
      serverSliceActions.setCurrentVoiceChannelId(8)
    );
    expect(s.currentVoiceChannelId).toBe(8);
    expect(s.ownVoiceState.sharingScreen).toBe(true);
    expect(s.ownVoiceState.webcamEnabled).toBe(true);
  });

  test('reconnect sweep that drops us from voice also clears the flags', () => {
    let s = inCallSharing();
    // Pretend the hosting server is the connected one so the sweep runs.
    s = { ...s, serverId: 'srv-public', currentVoiceServerPublicId: 'srv-public', ownUserId: 42 };
    s = reducer(
      s,
      serverSliceActions.setDeferredVoiceState({
        voiceMap: {},
        externalStreamsMap: {}
      })
    );
    expect(s.currentVoiceChannelId).toBeUndefined();
    expect(s.ownVoiceState.sharingScreen).toBe(false);
    expect(s.ownVoiceState.webcamEnabled).toBe(false);
    expect(s.ownVoiceState.serverMuted).toBe(false);
    expect(s.ownVoiceState.micMuted).toBe(true);
  });

  test('reconnect sweep that still finds us in voice leaves the flags alone', () => {
    let s = inCallSharing();
    s = { ...s, serverId: 'srv-public', currentVoiceServerPublicId: 'srv-public', ownUserId: 42 };
    s = reducer(
      s,
      serverSliceActions.setDeferredVoiceState({
        voiceMap: { 7: { users: { 42: s.ownVoiceState } } },
        externalStreamsMap: {}
      })
    );
    expect(s.currentVoiceChannelId).toBe(7);
    expect(s.ownVoiceState.sharingScreen).toBe(true);
  });
});
