import type { TJoinedServerSound } from '../../types';
import { and, count, eq } from 'drizzle-orm';
import { db } from '..';
import { files, serverSounds } from '../schema';

const soundSelectFields = {
  id: serverSounds.id,
  serverId: serverSounds.serverId,
  name: serverSounds.name,
  fileId: serverSounds.fileId,
  emoji: serverSounds.emoji,
  volume: serverSounds.volume,
  createdBy: serverSounds.createdBy,
  createdAt: serverSounds.createdAt,
  file: { id: files.id, name: files.name }
};

const getServerSounds = async (
  serverId: number
): Promise<TJoinedServerSound[]> =>
  db
    .select(soundSelectFields)
    .from(serverSounds)
    .innerJoin(files, eq(serverSounds.fileId, files.id))
    .where(eq(serverSounds.serverId, serverId))
    .orderBy(serverSounds.name);

const getSoundById = async (
  soundId: number
): Promise<TJoinedServerSound | undefined> => {
  const [row] = await db
    .select(soundSelectFields)
    .from(serverSounds)
    .innerJoin(files, eq(serverSounds.fileId, files.id))
    .where(eq(serverSounds.id, soundId))
    .limit(1);

  return row;
};

const countServerSounds = async (serverId: number): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(serverSounds)
    .where(eq(serverSounds.serverId, serverId));

  return row?.total ?? 0;
};

/** Case-insensitive name clash within one server (the unique index is exact). */
const soundNameTaken = async (
  serverId: number,
  name: string,
  exceptId?: number
): Promise<boolean> => {
  const rows = await db
    .select({ id: serverSounds.id, name: serverSounds.name })
    .from(serverSounds)
    .where(and(eq(serverSounds.serverId, serverId)));

  const wanted = name.toLowerCase();
  return rows.some((r) => r.id !== exceptId && r.name.toLowerCase() === wanted);
};

export { countServerSounds, getServerSounds, getSoundById, soundNameTaken };
