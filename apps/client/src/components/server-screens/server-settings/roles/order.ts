import { OWNER_ROLE_ID } from '@pulse/shared';
import type { TJoinedRole } from '@pulse/server/types';

type TPositioned = Pick<TJoinedRole, 'id' | 'position'>;

/** Highest role first — the order the hierarchy is read in everywhere. */
export const sortRolesByPosition = <T extends TPositioned>(roles: T[]): T[] =>
  [...roles].sort((a, b) => b.position - a.position || b.id - a.id);

/**
 * The caller's ceiling: the server lets a MANAGE_ROLES holder touch only
 * roles STRICTLY below their own highest role, and the owner touch
 * everything but the owner role (see server roles/_hierarchy.ts).
 */
export type TRoleCeiling = { owner: boolean; top: number };

export const getRoleCeiling = (
  ownRoles: TPositioned[],
  isOwner: boolean
): TRoleCeiling => ({
  owner: isOwner,
  top: ownRoles.reduce((max, r) => Math.max(max, r.position), -Infinity)
});

/**
 * Whether the caller may drag this role. Mirrors `roles.reorder`'s
 * movable set exactly, so the client never offers a drop the server
 * refuses: below the ceiling, and never the owner role (persistent and
 * not the default).
 */
export const isRoleMovable = (
  role: Pick<TJoinedRole, 'id' | 'position' | 'isPersistent' | 'isDefault'>,
  ceiling: TRoleCeiling
) => {
  if (role.id === OWNER_ROLE_ID) return false;
  if (role.isPersistent && !role.isDefault) return false;
  return ceiling.owner || role.position < ceiling.top;
};

/**
 * The `orderedRoleIds` payload for `roles.reorder` after dragging
 * `activeId` onto `overId` within the movable block (`movableIds`,
 * highest first). Returns null when the drop changes nothing or targets
 * an immovable row.
 */
export const reorderMovableRoles = (
  movableIds: number[],
  activeId: number,
  overId: number
): number[] | null => {
  const from = movableIds.indexOf(activeId);
  const to = movableIds.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...movableIds];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
};
