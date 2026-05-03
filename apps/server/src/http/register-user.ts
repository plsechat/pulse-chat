import {
  ActivityLogType,
  OWNER_ROLE_ID,
  type TJoinedUser
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { publishUser } from '../db/publishers';
import { getDefaultRole } from '../db/queries/roles';
import { getUserBySupabaseId } from '../db/queries/users';
import { logger } from '../logger';
import {
  serverMembers,
  servers,
  userRoles,
  users
} from '../db/schema';
import { enqueueActivityLog } from '../queues/activity-log';
import { invariant } from '../utils/invariant';

const BOOTSTRAP_SERVER_ID = 1;

const registerUser = async (
  supabaseUserId: string,
  inviteCode?: string,
  ip?: string,
  name?: string
): Promise<TJoinedUser> => {
  invariant(name, {
    code: 'BAD_REQUEST',
    message: 'Display name is required'
  });

  const now = Date.now();

  // Probe the owner-claim flag outside the heavy path. Once the bootstrap
  // server has an owner the value never goes back to NULL in normal
  // operation, so most registrations skip the transaction below and avoid
  // any lock on `servers[id=1]` — important because the test setup
  // TRUNCATE in beforeEach contends with this row and produced a deadlock.
  const [bootstrap] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .where(eq(servers.id, BOOTSTRAP_SERVER_ID))
    .limit(1);
  const ownerSlotIsOpen = !!bootstrap && bootstrap.ownerId == null;

  if (!ownerSlotIsOpen) {
    const [user] = await db
      .insert(users)
      .values({
        name,
        supabaseId: supabaseUserId,
        publicId: randomUUIDv7(),
        createdAt: now
      })
      .returning();

    invariant(user, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'User registration failed'
    });

    const defaultRole = await getDefaultRole();
    if (defaultRole) {
      await db
        .insert(userRoles)
        .values({
          userId: user.id,
          roleId: defaultRole.id,
          createdAt: now
        })
        .onConflictDoNothing();
    }
  }

  // First-user path: serialize through a transaction so concurrent
  // registrations are decided by the atomic UPDATE on servers.owner_id.
  // The probe above can lose the race (two callers see NULL simultaneously)
  // — the WHERE-isNull guard is the actual safety; the probe is just a
  // fast path for the common case.
  const becameOwner = ownerSlotIsOpen
    ? await db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            name,
            supabaseId: supabaseUserId,
            publicId: randomUUIDv7(),
            createdAt: now
          })
          .returning();

        invariant(user, {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'User registration failed'
        });

        const defaultRole = await getDefaultRole();
        if (defaultRole) {
          await tx
            .insert(userRoles)
            .values({
              userId: user.id,
              roleId: defaultRole.id,
              createdAt: now
            })
            .onConflictDoNothing();
        }

        const claim = await tx
          .update(servers)
          .set({ ownerId: user.id, updatedAt: now })
          .where(
            and(eq(servers.id, BOOTSTRAP_SERVER_ID), isNull(servers.ownerId))
          )
          .returning({ id: servers.id });

        if (claim.length === 0) return false;

        await tx
          .insert(serverMembers)
          .values({
            serverId: BOOTSTRAP_SERVER_ID,
            userId: user.id,
            joinedAt: now
          })
          .onConflictDoNothing();

        // Lockstep with servers.ownerId — keeps the legacy role-based owner
        // path consistent for downstream code that still inspects roleIds.
        await tx
          .insert(userRoles)
          .values({
            userId: user.id,
            roleId: OWNER_ROLE_ID,
            createdAt: now
          })
          .onConflictDoNothing();

        return true;
      })
    : false;

  const registeredUser = await getUserBySupabaseId(supabaseUserId);

  if (!registeredUser) {
    throw new Error('User registration failed');
  }

  if (becameOwner) {
    logger.warn(
      `[register] First user registered — granted ownership of server ${BOOTSTRAP_SERVER_ID}: supabaseId=${supabaseUserId}`
    );
  }

  publishUser(registeredUser.id, 'create');

  if (inviteCode) {
    enqueueActivityLog({
      type: ActivityLogType.USED_INVITE,
      userId: registeredUser.id,
      details: { code: inviteCode },
      ip
    });
  }

  return registeredUser;
};

export { registerUser };
