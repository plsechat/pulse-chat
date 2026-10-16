/**
 * voice-provider/media-policy — the pure half of what the provider asks
 * the browser for, plus the shared screen ladder clamp it relies on.
 *
 * Run via: bun test apps/client/src/components/voice-provider/__tests__/media-policy.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { clampScreenResolution, SCREEN_RESOLUTIONS } from '@pulse/shared';
import {
  describeMicError,
  SCREEN_SHARE_MAX_BITRATE,
  screenShareAudioConstraints,
  screenShareEncodings,
  transportIceOptions
} from '../media-policy';

describe('describeMicError', () => {
  test.each([
    ['NotAllowedError', 'permission denied'],
    ['NotFoundError', 'no microphone found'],
    ['NotReadableError', 'the device is busy or unreadable']
  ])('%s is a device problem the user can act on', (name, reason) => {
    expect(describeMicError(new DOMException('nope', name))).toBe(
      `Microphone unavailable: ${reason}`
    );
  });

  test('a plain object with a name is read the same way', () => {
    expect(describeMicError({ name: 'NotFoundError' })).toBe(
      'Microphone unavailable: no microphone found'
    );
  });

  test('anything else is not a device problem', () => {
    expect(describeMicError(new Error('produce failed'))).toBeNull();
    expect(describeMicError('string')).toBeNull();
    expect(describeMicError(undefined)).toBeNull();
    expect(describeMicError(null)).toBeNull();
  });
});

describe('screenShareAudioConstraints', () => {
  test('system audio on: stereo, 48 kHz, own-audio excluded', () => {
    expect(screenShareAudioConstraints(true)).toMatchObject({
      channelCount: 2,
      sampleRate: 48000,
      echoCancellation: false,
      autoGainControl: false,
      restrictOwnAudio: true
    });
  });

  test('system audio off: no audio is requested at all', () => {
    expect(screenShareAudioConstraints(false)).toBe(false);
  });
});

describe('screenShareEncodings', () => {
  test('one layer capped under the 6 Mbps server ceiling', () => {
    const encodings = screenShareEncodings();
    expect(encodings).toHaveLength(1);
    expect(encodings[0]!.maxBitrate).toBe(SCREEN_SHARE_MAX_BITRATE);
    expect(SCREEN_SHARE_MAX_BITRATE).toBeLessThan(6_000_000);
  });
});

describe('transportIceOptions', () => {
  test('no relay configured → nothing is passed (ICE-lite needs no STUN)', () => {
    expect(transportIceOptions(undefined)).toEqual({});
    expect(transportIceOptions({})).toEqual({});
    expect(transportIceOptions({ iceServers: [] })).toEqual({});
  });

  test('configured TURN servers reach both transports as iceServers', () => {
    expect(
      transportIceOptions({
        iceServers: [
          {
            urls: ['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349'],
            username: 'u',
            credential: 'c'
          }
        ]
      })
    ).toEqual({
      iceServers: [
        {
          urls: ['turn:turn.example:3478?transport=udp', 'turns:turn.example:5349'],
          username: 'u',
          credential: 'c'
        }
      ]
    });
  });

  test('the transport policy is forwarded with servers', () => {
    expect(
      transportIceOptions({
        iceServers: [{ urls: 'turn:turn.example:3478' }],
        iceTransportPolicy: 'relay'
      })
    ).toEqual({
      iceServers: [{ urls: 'turn:turn.example:3478', username: undefined, credential: undefined }],
      iceTransportPolicy: 'relay'
    });
  });

  test('a relay-only policy with nothing to relay through is dropped', () => {
    expect(transportIceOptions({ iceTransportPolicy: 'relay' })).toEqual({});
  });
});

describe('clampScreenResolution (shared ladder)', () => {
  const lowest = SCREEN_RESOLUTIONS[SCREEN_RESOLUTIONS.length - 1];

  test('a rung the ladder does not know resolves to the lowest rung, never the cap', () => {
    expect(clampScreenResolution('144p', '1080p')).toBe(lowest);
    expect(clampScreenResolution(undefined, '1080p')).toBe(lowest);
  });

  test('a rung above the cap is pulled down to it', () => {
    expect(clampScreenResolution('2160p', '1080p')).toBe('1080p');
  });

  test('a rung at or below the cap is kept', () => {
    expect(clampScreenResolution('1080p', '1080p')).toBe('1080p');
    expect(clampScreenResolution('480p', '1080p')).toBe('480p');
  });

  test('no cap (older server) leaves the request untouched', () => {
    expect(clampScreenResolution('144p', undefined)).toBe('144p');
    expect(clampScreenResolution('2160p', 'bogus')).toBe('2160p');
  });
});
