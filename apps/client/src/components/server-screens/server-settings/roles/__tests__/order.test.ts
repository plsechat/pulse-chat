/**
 * Roles editor ordering: highest position first, and the draggable set
 * mirrors the server's `roles.reorder` movable set exactly.
 *
 * Run via: bun test apps/client/src/components/server-screens/server-settings/roles/__tests__/order.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { OWNER_ROLE_ID } from '@pulse/shared';
import {
  getRoleCeiling,
  isRoleMovable,
  reorderMovableRoles,
  sortRolesByPosition
} from '../order';

const role = (
  id: number,
  position: number,
  flags: { isPersistent?: boolean; isDefault?: boolean } = {}
) => ({
  id,
  position,
  isPersistent: flags.isPersistent ?? false,
  isDefault: flags.isDefault ?? false
});

const owner = role(OWNER_ROLE_ID, 5, { isPersistent: true });
const admin = role(10, 4);
const mod = role(11, 3);
const member = role(12, 2, { isPersistent: true, isDefault: true });
const guest = role(13, 1);

describe('sortRolesByPosition', () => {
  test('highest first, ties broken by id, input untouched', () => {
    const input = [guest, member, admin, owner, mod];
    const sorted = sortRolesByPosition(input);
    expect(sorted.map((r) => r.id)).toEqual([OWNER_ROLE_ID, 10, 11, 12, 13]);
    expect(input[0]).toBe(guest);
    expect(sortRolesByPosition([role(2, 1), role(3, 1)]).map((r) => r.id)).toEqual([3, 2]);
  });
});

describe('isRoleMovable', () => {
  test('a moderator moves only roles strictly below their own', () => {
    const ceiling = getRoleCeiling([mod], false);
    expect(ceiling).toEqual({ owner: false, top: 3 });
    expect(isRoleMovable(mod, ceiling)).toBe(false);
    expect(isRoleMovable(admin, ceiling)).toBe(false);
    expect(isRoleMovable(member, ceiling)).toBe(true);
    expect(isRoleMovable(guest, ceiling)).toBe(true);
  });

  test('the server owner moves everything except the owner role', () => {
    const ceiling = getRoleCeiling([owner], true);
    expect(isRoleMovable(owner, ceiling)).toBe(false);
    expect(isRoleMovable(admin, ceiling)).toBe(true);
    expect(isRoleMovable(member, ceiling)).toBe(true);
  });

  test('no roles at all means nothing is movable', () => {
    const ceiling = getRoleCeiling([], false);
    expect(isRoleMovable(guest, ceiling)).toBe(false);
  });
});

describe('reorderMovableRoles', () => {
  test('moves the dragged id to the drop index, highest first', () => {
    expect(reorderMovableRoles([10, 11, 12, 13], 13, 10)).toEqual([13, 10, 11, 12]);
    expect(reorderMovableRoles([10, 11, 12, 13], 10, 12)).toEqual([11, 12, 10, 13]);
  });

  test('is null for a no-op or an immovable target', () => {
    expect(reorderMovableRoles([10, 11], 10, 10)).toBeNull();
    expect(reorderMovableRoles([10, 11], 10, OWNER_ROLE_ID)).toBeNull();
    expect(reorderMovableRoles([10, 11], 99, 10)).toBeNull();
  });
});
