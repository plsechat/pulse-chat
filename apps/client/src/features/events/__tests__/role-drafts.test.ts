/**
 * Roles editor drafts: the client-side mirror of the server's role
 * bounds, key derivation and the draft ↔ role conversions.
 *
 * Run via: bun test apps/client/src/features/events/__tests__/role-drafts.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  draftsToRoles,
  keyFromLabel,
  roleToDraft,
  validateRoleDrafts,
  type TRoleDraft
} from '../role-drafts';

const draft = (patch: Partial<TRoleDraft> = {}): TRoleDraft => ({
  key: 'tank',
  label: 'Tank',
  cap: '2',
  color: '#60a5fa',
  ...patch
});

describe('keyFromLabel', () => {
  test('lowercases, dashes and trims to the key bounds', () => {
    expect(keyFromLabel('Main Tank')).toBe('main-tank');
    expect(keyFromLabel('  DPS!! ')).toBe('dps');
    expect(keyFromLabel('a'.repeat(40))).toHaveLength(24);
    expect(keyFromLabel('')).toBe('');
  });
});

describe('validateRoleDrafts', () => {
  test('a valid roster has no messages', () => {
    const r = validateRoleDrafts([
      draft(),
      draft({ key: 'dps', label: 'DPS', cap: '' })
    ]);
    expect(r.ok).toBe(true);
    expect(r.general).toBeUndefined();
    expect(r.rows).toEqual([{}, {}]);
  });

  test('each server bound is reported on its field', () => {
    const r = validateRoleDrafts([
      draft({ key: '', label: '' }),
      draft({ key: 'bad key', cap: '0' }),
      draft({
        key: 'x'.repeat(25),
        label: 'y'.repeat(41),
        cap: '201',
        color: 'red'
      })
    ]);
    expect(r.ok).toBe(false);
    expect(r.rows[0]).toEqual({ key: 'Required', label: 'Required' });
    expect(r.rows[1]!.key).toMatch(/Letters/);
    expect(r.rows[1]!.cap).toMatch(/1–200/);
    expect(r.rows[2]!.key).toMatch(/24/);
    expect(r.rows[2]!.label).toMatch(/40/);
    expect(r.rows[2]!.cap).toMatch(/1–200/);
    expect(r.rows[2]!.color).toMatch(/#rrggbb/);
  });

  test('duplicate keys are flagged on the later row', () => {
    const r = validateRoleDrafts([draft(), draft({ label: 'Off tank' })]);
    expect(r.rows[0]).toEqual({});
    expect(r.rows[1]!.key).toBe('Keys must be unique');
  });

  test('roster size bounds', () => {
    expect(validateRoleDrafts([]).general).toMatch(/at least one/);
    const many = Array.from({ length: 13 }, (_, i) => draft({ key: `r${i}` }));
    expect(validateRoleDrafts(many).general).toMatch(/12/);
  });
});

describe('conversions', () => {
  test('draft ↔ role keeps unlimited caps and fills a missing colour', () => {
    const role = { key: 'flex', label: 'Flex', cap: null, color: null };
    const d = roleToDraft(role);
    expect(d.cap).toBe('');
    expect(d.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(draftsToRoles([d])).toEqual([
      { key: 'flex', label: 'Flex', cap: null, color: d.color }
    ]);
    expect(
      draftsToRoles([draft({ key: ' tank ', label: ' Tank ', cap: '2' })])
    ).toEqual([{ key: 'tank', label: 'Tank', cap: 2, color: '#60a5fa' }]);
  });
});
