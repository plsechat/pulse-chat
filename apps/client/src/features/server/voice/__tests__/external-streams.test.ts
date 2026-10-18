/**
 * The hidden plugin-stream player only knows a stream id; its volume is
 * stored by the plugin/key pair the stream was announced with, under
 * whichever channel announced it.
 *
 * Run via:
 *   bun test apps/client/src/features/server/voice/__tests__/external-streams.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { TExternalStreamsMap } from '@pulse/shared';
import { externalStreamVolumeKey, findExternalStream } from '../external-streams';

const map: TExternalStreamsMap = {
  10: {
    1: { title: 'Radio', key: 'radio', pluginId: 'music', tracks: { audio: true } }
  },
  11: {
    2: { title: 'Cam', key: 'cam', pluginId: 'cctv', tracks: { video: true } }
  }
};
const keyFor = (pluginId: string, key: string) => `external-${pluginId}-${key}`;

describe('findExternalStream', () => {
  test('finds a stream whichever channel announced it', () => {
    expect(findExternalStream(map, 1)?.pluginId).toBe('music');
    expect(findExternalStream(map, 2)?.pluginId).toBe('cctv');
  });

  test('unknown id → undefined', () => {
    expect(findExternalStream(map, 3)).toBeUndefined();
    expect(findExternalStream({}, 1)).toBeUndefined();
  });
});

describe('externalStreamVolumeKey', () => {
  test('is the same key the card slider writes', () => {
    expect(externalStreamVolumeKey(map, 1, keyFor)).toBe('external-music-radio');
  });

  test('an unannounced stream has no key (plays at full volume)', () => {
    expect(externalStreamVolumeKey(map, 9, keyFor)).toBeUndefined();
  });
});
