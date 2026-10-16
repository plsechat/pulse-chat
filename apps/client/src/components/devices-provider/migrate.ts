import { Resolution, type TDeviceSettings } from '@/types';
import { SCREEN_FRAMERATES, SCREEN_RESOLUTIONS } from '@pulse/shared';

/**
 * Stored device settings carry a schema version so a one-time migration
 * can tell "the old default" from "the user's choice". Bump it whenever a
 * field's meaning or default changes in a way that must not re-apply to
 * settings the user has since set deliberately.
 *
 *  v1 (unversioned): `noiseSuppression: boolean`; `shareSystemAudio`
 *     persisted at a default of false with no UI and no effect; the
 *     screen quality selectors offered rungs the shared ladder does not.
 *  v2: `noiseSuppressionMode`; `shareSystemAudio` is a real toggle
 *     (default ON, matching what every share did before); screen quality
 *     is confined to the shared ladder.
 */
export const DEVICE_SETTINGS_SCHEMA_VERSION = 2;

export type TStoredDeviceSettings = Partial<TDeviceSettings> & {
  schemaVersion?: number;
  /** Pre-noise-gate shape. */
  noiseSuppression?: boolean;
};

/** Highest ladder framerate at or below the stored one (lowest if none). */
const snapFramerate = (value: number): number => {
  const atOrBelow = SCREEN_FRAMERATES.filter((f) => f <= value);
  return atOrBelow.length > 0
    ? atOrBelow[atOrBelow.length - 1]
    : SCREEN_FRAMERATES[0];
};

/** The stored resolution when the ladder knows it, else its lowest rung. */
const snapResolution = (value: string): Resolution =>
  (SCREEN_RESOLUTIONS as readonly string[]).includes(value)
    ? (value as Resolution)
    : (SCREEN_RESOLUTIONS[SCREEN_RESOLUTIONS.length - 1] as Resolution);

/**
 * Settings to run with, from whatever the browser had stored. Unknown
 * fields fall back to the defaults; a pre-v2 object is migrated field by
 * field as documented above.
 */
export const migrateStoredDeviceSettings = (
  saved: TStoredDeviceSettings | undefined,
  defaults: TDeviceSettings
): TDeviceSettings => {
  if (!saved) return defaults;

  const merged: TDeviceSettings = { ...defaults, ...saved };
  const version = saved.schemaVersion ?? 1;

  if (version >= DEVICE_SETTINGS_SCHEMA_VERSION) return merged;

  return {
    ...merged,
    noiseSuppressionMode:
      saved.noiseSuppressionMode ??
      (saved.noiseSuppression ? 'automatic' : 'off'),
    noiseGateThreshold: saved.noiseGateThreshold ?? defaults.noiseGateThreshold,
    // No UI could have set this before v2, so a stored value is the old
    // default — not a choice — and every share sent system audio anyway.
    shareSystemAudio: defaults.shareSystemAudio,
    screenFramerate: snapFramerate(merged.screenFramerate),
    screenResolution: snapResolution(merged.screenResolution)
  };
};
