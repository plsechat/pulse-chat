import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq, gt, gte, max, sql } from 'drizzle-orm';
import { db } from '../../db';
import { publishRole } from '../../db/publishers';
import { roles } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedureFor } from '../../utils/procedures';
import { getRoleCeiling } from './_hierarchy';

const addRoleRoute = serverProcedureFor(Permission.MANAGE_ROLES).mutation(
  async ({ input, ctx }) => {
    const ceiling = await getRoleCeiling(ctx.userId, input.serverId);

    // The new role lands directly below the caller's highest role: the
    // owner's new role sits right under the owner role, a moderator's
    // right under their own top role. Either way it is inside the
    // caller's ceiling, so they can go on to edit it.
    const role = await db.transaction(async (tx) => {
      let position: number;

      if (ceiling.owner) {
        const isOwnerRole = sql`(${roles.isPersistent} AND NOT ${roles.isDefault})`;

        const [row] = await tx
          .select({ maxPos: max(roles.position) })
          .from(roles)
          .where(
            and(eq(roles.serverId, input.serverId), sql`NOT ${isOwnerRole}`)
          );

        position = (row?.maxPos ?? 0) + 1;

        // Pin the owner role directly above the new role: it stays the
        // highest, and the new role sits right under it.
        await tx
          .update(roles)
          .set({ position: position + 1 })
          .where(and(eq(roles.serverId, input.serverId), isOwnerRole));
      } else {
        invariant(Number.isFinite(ceiling.top), {
          code: 'FORBIDDEN',
          message: 'You hold no role in this server'
        });

        position = ceiling.top;

        await tx
          .update(roles)
          .set({ position: sql`${roles.position} + 1` })
          .where(
            and(
              eq(roles.serverId, input.serverId),
              gte(roles.position, position)
            )
          );
      }

      const [created] = await tx
        .insert(roles)
        .values({
          name: 'New Role',
          color: '#ffffff',
          isDefault: false,
          isPersistent: false,
          serverId: input.serverId,
          position,
          createdAt: Date.now()
        })
        .returning();

      return created!;
    });

    publishRole(role.id, 'create');

    // Every role that was shifted up to make room changed position.
    const shifted = await db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(eq(roles.serverId, input.serverId), gt(roles.position, role.position))
      );
    for (const { id } of shifted) publishRole(id, 'update');

    enqueueActivityLog({
      type: ActivityLogType.CREATED_ROLE,
      userId: ctx.user.id,
      details: {
        roleId: role.id,
        roleName: role.name
      }
    });

    return role.id;
  }
);

export { addRoleRoute };
