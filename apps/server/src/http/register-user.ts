import { ActivityLogType, type TJoinedUser } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { db } from '../db';
import { publishUser } from '../db/publishers';
import { getDefaultRole } from '../db/queries/roles';
import { getUserBySupabaseId } from '../db/queries/users';
import { userRoles, users } from '../db/schema';
import { enqueueActivityLog } from '../queues/activity-log';
import { invariant } from '../utils/invariant';

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

  const [user] = await db
    .insert(users)
    .values({
      name,
      supabaseId: supabaseUserId,
      publicId: randomUUIDv7(),
      createdAt: Date.now()
    })
    .returning();

  // Assign the default role to the new user
  const defaultRole = await getDefaultRole();
  if (defaultRole) {
    await db
      .insert(userRoles)
      .values({
        userId: user!.id,
        roleId: defaultRole.id,
        createdAt: Date.now()
      })
      .onConflictDoNothing();
  }

  publishUser(user!.id, 'create');

  const registeredUser = await getUserBySupabaseId(supabaseUserId);

  if (!registeredUser) {
    throw new Error('User registration failed');
  }

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
