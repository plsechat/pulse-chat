/**
 * The "Server Settings" menu entry and the settings shell share one
 * permission list, derived from the sections — a section can never be
 * reachable without a menu entry (A8-5).
 *
 * Run via: bun test apps/client/src/components/server-screens/__tests__/server-settings-permissions.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { Permission } from '@pulse/shared';
import {
  canOpenServerSettings,
  SECTION_PERMISSIONS,
  SERVER_SETTINGS_PERMISSIONS
} from '../server-settings/permissions';

describe('SERVER_SETTINGS_PERMISSIONS', () => {
  test('is exactly the distinct set of section permissions', () => {
    const expected = new Set(Object.values(SECTION_PERMISSIONS));
    expect(new Set(SERVER_SETTINGS_PERMISSIONS)).toEqual(expected);
    expect(SERVER_SETTINGS_PERMISSIONS.length).toBe(expected.size);
  });

  test('covers the moderation-only sections the old sidebar list missed', () => {
    for (const perm of [
      Permission.VIEW_REPORTS,
      Permission.MANAGE_WEBHOOKS,
      Permission.MANAGE_AUTOMOD
    ]) {
      expect(SERVER_SETTINGS_PERMISSIONS).toContain(perm);
    }
    // No dead permissions: storage limits moved into General
    // (MANAGE_SETTINGS) and the updater is gone.
  });
});

describe('canOpenServerSettings', () => {
  const canWith =
    (granted: Permission[]) => (p: Permission | Permission[]) =>
      (Array.isArray(p) ? p : [p]).some((x) => granted.includes(x));

  test('any single section permission opens the screen', () => {
    expect(canOpenServerSettings(canWith([Permission.VIEW_REPORTS]), false, null)).toBe(true);
    expect(canOpenServerSettings(canWith([Permission.MANAGE_AUTOMOD]), false, null)).toBe(true);
    expect(canOpenServerSettings(canWith([]), false, null)).toBe(false);
  });

  test('the instance owner reaches the Instance group without any server permission, on the home instance only', () => {
    expect(canOpenServerSettings(canWith([]), true, null)).toBe(true);
    expect(canOpenServerSettings(canWith([]), true, undefined)).toBe(true);
    expect(canOpenServerSettings(canWith([]), true, 'peer.example')).toBe(false);
  });
});
