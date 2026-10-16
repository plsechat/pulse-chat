/**
 * Output-device routing: the chosen Output Device applies to every
 * player, the system-audio capture bypass overrides it, and browsers
 * without setSinkId are left alone.
 *
 * Run via:
 *   bun test apps/client/src/components/voice-provider/__tests__/output-sink.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { applySinkId, resolveOutputSinkId } from '../output-sink';

describe('resolveOutputSinkId', () => {
  test('nothing chosen → browser default', () => {
    expect(resolveOutputSinkId(undefined, undefined)).toBe('');
    expect(resolveOutputSinkId(undefined, '')).toBe('');
    expect(resolveOutputSinkId(undefined, 'default')).toBe('');
  });

  test('the chosen Output Device is honoured', () => {
    expect(resolveOutputSinkId(undefined, 'headset-123')).toBe('headset-123');
  });

  test('the capture bypass wins over the chosen device', () => {
    expect(resolveOutputSinkId('real-output', 'headset-123')).toBe(
      'real-output'
    );
    expect(resolveOutputSinkId('real-output', undefined)).toBe('real-output');
  });
});

describe('applySinkId', () => {
  test('routes a target that supports setSinkId', async () => {
    const calls: string[] = [];
    const target = {
      setSinkId: async (id: string) => {
        calls.push(id);
      }
    };
    applySinkId(target as unknown as HTMLMediaElement, 'headset-123');
    await Promise.resolve();
    expect(calls).toEqual(['headset-123']);
  });

  test('ignores a missing target or one without setSinkId', () => {
    expect(() => applySinkId(null, 'x')).not.toThrow();
    expect(() => applySinkId({} as HTMLMediaElement, 'x')).not.toThrow();
  });

  test('a rejected setSinkId is swallowed', async () => {
    const target = {
      setSinkId: () => Promise.reject(new Error('device unplugged'))
    };
    applySinkId(target as unknown as AudioContext, 'gone');
    // An unhandled rejection would fail the run.
    await new Promise((r) => setTimeout(r, 0));
  });
});
