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

  // Wrapped in a transaction so the owner-claim race is decided by the
  // atomic UPDATE on servers.owner_id below — only one concurrent registrar
  // can flip the row from NULL to a userId.
  const becameOwner = await db.transaction(async (tx) => {
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

    // Atomic owner claim: only succeeds if servers[id=1].owner_id is still
    // NULL. The first transaction to commit wins; subsequent registrations
    // get 0 rows back and proceed as a regular user.
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
  });

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
