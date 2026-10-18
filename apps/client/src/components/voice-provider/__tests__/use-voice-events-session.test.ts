/**
 * useVoiceEvents session matching: producer events carry `kind` as the
 * STREAM kind (audio / video / screen …), roster events as the ROOM kind
 * ('channel' | 'dm'). Only the latter may be compared with the session's
 * room kind — comparing a stream kind would drop every media event.
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { describe, expect, test } from 'bun:test';
import { __testing } from '../hooks/use-voice-events';

const { isForCurrentSession } = __testing;

describe('isForCurrentSession', () => {
  test('a producer event for our channel passes although its kind is a stream kind', () => {
    expect(isForCurrentSession({ channelId: 5, kind: 'audio' }, 5, 'channel')).toBe(true);
    expect(isForCurrentSession({ channelId: 5, kind: 'screen' }, 5, 'dm')).toBe(true);
  });

  test('a roster event names the room kind and must match it', () => {
    expect(isForCurrentSession({ channelId: 5, kind: 'channel' }, 5, 'channel')).toBe(true);
    expect(isForCurrentSession({ channelId: 5, kind: 'dm' }, 5, 'channel')).toBe(false);
    expect(isForCurrentSession({ channelId: 5, kind: 'channel' }, 5, 'dm')).toBe(false);
  });

  test('no kind at all (older server) is taken as-is; another channel never matches', () => {
    expect(isForCurrentSession({ channelId: 5 }, 5, 'channel')).toBe(true);
    expect(isForCurrentSession({ channelId: 6, kind: 'audio' }, 5, 'channel')).toBe(false);
    expect(isForCurrentSession({ channelId: 5 }, undefined, 'channel')).toBe(false);
  });
});
