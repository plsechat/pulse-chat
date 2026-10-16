import { ActivityLogType, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishRole } from '../../db/publishers';
import { roles } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { getRoleCeiling, isBelowCeiling } from './_hierarchy';

/**
 * Re-rank the roles of the active server. `orderedRoleIds` is the
 * complete desired order, highest first, of exactly the roles the
 * caller is allowed to move: every role strictly below their highest
 * role, except the owner role (which is pinned to the top). Roles at or
 * above the caller's ceiling keep their relative order above the moved
 * block. Positions are compacted to 1..n afterwards.
 */
const reorderRolesRoute = serverProcedure(Permission.MANAGE_ROLES)
  .input(
    z.object({
      orderedRoleIds: z.array(z.number().int().positive()).min(1).max(200)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const ids = input.orderedRoleIds;

    invariant(new Set(ids).size === ids.length, {
      code: 'BAD_REQUEST',
      message: 'orderedRoleIds contains duplicates'
    });

    const [ceiling, serverRoles] = await Promise.all([
      getRoleCeiling(ctx.userId, ctx.activeServerId),
      db
        .select({
          id: roles.id,
          position: roles.position,
          isPersistent: roles.isPersistent,
          isDefault: roles.isDefault
        })
        .from(roles)
        .where(eq(roles.serverId, ctx.activeServerId))
    ]);

    const movable = serverRoles.filter(
      (r) =>
        isBelowCeiling(ceiling, r.position) && !(r.isPersistent && !r.isDefault)
    );
    const movableIds = new Set(movable.map((r) => r.id));

    invariant(
      ids.length === movable.length && ids.every((id) => movableIds.has(id)),
      {
        code: 'FORBIDDEN',
        message: 'orderedRoleIds must list exactly the roles below your highest role'
      }
    );

    const fixed = serverRoles
      .filter((r) => !movableIds.has(r.id))
      .sort((a, b) => a.position - b.position || a.id - b.id);

    const target = new Map<number, number>();
    [...ids].reverse().forEach((id, i) => target.set(id, i + 1));
    fixed.forEach((r, i) => target.set(r.id, ids.length + 1 + i));

    const changed = serverRoles.filter((r) => target.get(r.id) !== r.position);

    if (changed.length > 0) {
      const now = Date.now();
      await db.transaction(async (tx) => {
        for (const role of changed) {
          await tx
            .update(roles)
            .set({ position: target.get(role.id)!, updatedAt: now })
            .where(eq(roles.id, role.id));
        }
      });
    }

    for (const role of changed) publishRole(role.id, 'update');

    if (changed.length > 0) {
      enqueueActivityLog({
        type: ActivityLogType.UPDATED_ROLE,
        userId: ctx.user.id,
        details: {
          roleId: changed[0]!.id,
          permissions: [],
          values: { position: target.get(changed[0]!.id) }
        }
      });
    }
  });

export { reorderRolesRoute };
