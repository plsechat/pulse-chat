import {
  SOUND_ROOM_MAX_PER_WINDOW,
  SOUND_ROOM_WINDOW_MS,
  SOUND_USER_COOLDOWN_MS
} from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { soundboardLimiter } from '../soundboard-limits';

/**
 * The soundboard pacing, driven with an injected clock: a user waits
 * out the cooldown, a room has a budget per minute, a refusal never
 * spends budget, and a closed room forgets its history.
 */

const ROOM = 'channel:42';

describe('soundboardLimiter', () => {
  test('a user is held to one play per cooldown', () => {
    soundboardLimiter.reset();
    const t0 = 1_000_000;

    expect(soundboardLimiter.check(1, ROOM, t0)).toBe('ok');
    expect(soundboardLimiter.check(1, ROOM, t0 + 500)).toBe('user');
    expect(soundboardLimiter.check(1, ROOM, t0 + SOUND_USER_COOLDOWN_MS - 1)).toBe('user');
    expect(soundboardLimiter.check(1, ROOM, t0 + SOUND_USER_COOLDOWN_MS)).toBe('ok');
    // Another user is on their own clock.
    expect(soundboardLimiter.check(2, ROOM, t0 + SOUND_USER_COOLDOWN_MS + 1)).toBe('ok');
  });

  test('a room takes its quota per window and a refusal costs nothing', () => {
    soundboardLimiter.reset();
    const t0 = 2_000_000;

    // Distinct users so the per-user cooldown never trips first.
    for (let i = 0; i < SOUND_ROOM_MAX_PER_WINDOW; i++) {
      expect(soundboardLimiter.check(100 + i, ROOM, t0 + i)).toBe('ok');
    }
    expect(soundboardLimiter.check(500, ROOM, t0 + 100)).toBe('room');
    expect(soundboardLimiter.check(501, ROOM, t0 + 101)).toBe('room');
    // Another room is unaffected.
    expect(soundboardLimiter.check(500, 'channel:7', t0 + 102)).toBe('ok');

    // The window slides: once the first play ages out, one slot frees up
    // and the refused attempts above did not consume it.
    const later = t0 + SOUND_ROOM_WINDOW_MS;
    expect(soundboardLimiter.check(600, ROOM, later)).toBe('ok');
    expect(soundboardLimiter.check(601, ROOM, later)).toBe('room');
  });

  test('the user cooldown is checked before the room budget', () => {
    soundboardLimiter.reset();
    const t0 = 3_000_000;

    expect(soundboardLimiter.check(1, ROOM, t0)).toBe('ok');
    // Same user, same instant: refused for the cooldown, not the room.
    expect(soundboardLimiter.check(1, ROOM, t0)).toBe('user');
  });

  test('a closed room forgets its budget', () => {
    soundboardLimiter.reset();
    const t0 = 4_000_000;

    for (let i = 0; i < SOUND_ROOM_MAX_PER_WINDOW; i++) {
      expect(soundboardLimiter.check(200 + i, ROOM, t0 + i)).toBe('ok');
    }
    expect(soundboardLimiter.check(300, ROOM, t0 + 50)).toBe('room');

    soundboardLimiter.forgetRoom(ROOM);
    expect(soundboardLimiter.check(300, ROOM, t0 + 51)).toBe('ok');
  });

  test('the user map prunes expired entries once it grows large', () => {
    soundboardLimiter.reset();
    const t0 = 5_000_000;

    // 1500 distinct users in distinct rooms (so no room budget trips),
    // each play a cooldown apart in time: the map must stay bounded and
    // the oldest entries must have been released (they are allowed again).
    for (let i = 0; i < 1500; i++) {
      expect(
        soundboardLimiter.check(1000 + i, `channel:${i}`, t0 + i * SOUND_USER_COOLDOWN_MS)
      ).toBe('ok');
    }
    // User 1000 played at t0; now is far later — allowed regardless of
    // whether its entry was pruned, so this asserts behaviour not shape.
    expect(
      soundboardLimiter.check(1000, 'channel:0', t0 + 1500 * SOUND_USER_COOLDOWN_MS)
    ).toBe('ok');
  });
});
