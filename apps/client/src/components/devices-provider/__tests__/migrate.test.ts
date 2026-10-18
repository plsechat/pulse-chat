/**
 * devices-provider/migrate — stored device settings across schema
 * versions.
 *
 *  - nothing stored → the defaults
 *  - a v2 object is taken as-is (a deliberate "system audio off" sticks)
 *  - a pre-v2 object: noise-suppression shape migrated, the never-
 *    exposed shareSystemAudio reset to the default, screen rungs the
 *    ladder does not offer snapped onto it
 *
 * Run via: bun test apps/client/src/components/devices-provider/__tests__/migrate.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { Resolution, type TDeviceSettings } from '@/types';
import {
  DEVICE_SETTINGS_SCHEMA_VERSION,
  migrateStoredDeviceSettings
} from '../migrate';

const defaults: TDeviceSettings = {
  microphoneId: undefined,
  playbackId: undefined,
  webcamId: undefined,
  webcamResolution: Resolution['720p'],
  webcamFramerate: 30,
  echoCancellation: false,
  noiseSuppressionMode: 'automatic',
  noiseGateThreshold: -50,
  autoGainControl: true,
  shareSystemAudio: true,
  screenResolution: Resolution['720p'],
  screenFramerate: 15,
  screenAudioBitrate: 128
};

describe('migrateStoredDeviceSettings', () => {
  test('nothing stored → defaults', () => {
    expect(migrateStoredDeviceSettings(undefined, defaults)).toEqual(defaults);
  });

  test('a current-version object is taken as-is, including system audio off', () => {
    const stored = {
      ...defaults,
      shareSystemAudio: false,
      screenFramerate: 30,
      schemaVersion: DEVICE_SETTINGS_SCHEMA_VERSION
    };

    const out = migrateStoredDeviceSettings(stored, defaults);

    expect(out.shareSystemAudio).toBe(false);
    expect(out.screenFramerate).toBe(30);
    expect('schemaVersion' in out).toBe(true);
  });

  test('a pre-v2 object: the never-exposed system-audio flag resets to the default', () => {
    const out = migrateStoredDeviceSettings(
      { ...defaults, shareSystemAudio: false },
      defaults
    );

    expect(out.shareSystemAudio).toBe(true);
  });

  test('a pre-v2 object keeps the noise-suppression choice in its new shape', () => {
    const legacy = { microphoneId: 'mic-1', noiseSuppression: false };

    const out = migrateStoredDeviceSettings(legacy, defaults);

    expect(out.microphoneId).toBe('mic-1');
    expect(out.noiseSuppressionMode).toBe('off');
    expect(out.noiseGateThreshold).toBe(defaults.noiseGateThreshold);
    expect(
      migrateStoredDeviceSettings({ noiseSuppression: true }, defaults)
        .noiseSuppressionMode
    ).toBe('automatic');
  });

  test('a pre-v2 object: screen rungs the ladder does not offer snap onto it', () => {
    const out = migrateStoredDeviceSettings(
      {
        ...defaults,
        screenResolution: '144p' as Resolution,
        screenFramerate: 120
      },
      defaults
    );

    expect(out.screenResolution).toBe(Resolution['240p']);
    expect(out.screenFramerate).toBe(60);
    expect(
      migrateStoredDeviceSettings({ screenFramerate: 24 }, defaults)
        .screenFramerate
    ).toBe(15);
    expect(
      migrateStoredDeviceSettings({ screenFramerate: 10 }, defaults)
        .screenFramerate
    ).toBe(15);
  });

  test('a pre-v2 object: ladder rungs the user chose are kept', () => {
    const out = migrateStoredDeviceSettings(
      { ...defaults, screenResolution: Resolution['1080p'], screenFramerate: 30 },
      defaults
    );

    expect(out.screenResolution).toBe(Resolution['1080p']);
    expect(out.screenFramerate).toBe(30);
  });
});
