import type { TJoinedNameplate } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '..';
import { files, nameplates, serverMembers } from '../schema';

const getNameplates = async (serverId: number): Promise<TJoinedNameplate[]> => {
  const rows = await db
    .select({
      id: nameplates.id,
      name: nameplates.name,
      file: { id: files.id, name: files.name }
    })
    .from(nameplates)
    .innerJoin(files, eq(nameplates.fileId, files.id))
    .where(eq(nameplates.serverId, serverId));

  return rows;
};

/**
 * Membership-scoped existence check for equipping 'custom:<id>' — true
 * only when the pack exists AND the user is a member of its server.
 */
const canUserEquipNameplate = async (
  nameplateId: number,
  userId: number
): Promise<boolean> => {
  const [row] = await db
    .select({ id: nameplates.id })
    .from(nameplates)
    .innerJoin(
      serverMembers,
      and(
        eq(serverMembers.serverId, nameplates.serverId),
        eq(serverMembers.userId, userId)
      )
    )
    .where(eq(nameplates.id, nameplateId))
    .limit(1);

  return !!row;
};

export { canUserEquipNameplate, getNameplates };
