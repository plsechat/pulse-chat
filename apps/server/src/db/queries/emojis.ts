import type { TJoinedEmoji } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '..';
import { emojis, files, users } from '../schema';

const emojiSelectFields = {
  emoji: emojis,
  file: files,
  user: {
    id: users.id,
    name: users.name,
    bannerColor: users.bannerColor,
    bio: users.bio,
    createdAt: users.createdAt,
    banned: users.banned,
    avatarId: users.avatarId,
    bannerId: users.bannerId
  }
};

// TODO: check this any
const parseEmoji = (row: any): TJoinedEmoji => ({
  ...row.emoji,
  file: row.file,
  user: row.user
});

const getEmojiById = async (id: number): Promise<TJoinedEmoji | undefined> => {
  const [row] = await db
    .select(emojiSelectFields)
    .from(emojis)
    .innerJoin(files, eq(emojis.fileId, files.id))
    .innerJoin(users, eq(emojis.userId, users.id))
    .where(eq(emojis.id, id))
    .limit(1);

  if (!row) return undefined;

  return parseEmoji(row);
};

const getEmojis = async (serverId?: number): Promise<TJoinedEmoji[]> => {
  let query = db
    .select(emojiSelectFields)
    .from(emojis)
    .innerJoin(files, eq(emojis.fileId, files.id))
    .innerJoin(users, eq(emojis.userId, users.id));

  if (serverId !== undefined) {
    query = query.where(eq(emojis.serverId, serverId)) as typeof query;
  }

  const rows = await query;

  return rows.map(parseEmoji);
};

const emojiExists = async (name: string): Promise<boolean> => {
  const [emoji] = await db
    .select()
    .from(emojis)
    .where(eq(emojis.name, name))
    .limit(1);

  return !!emoji;
};

const getUniqueEmojiName = async (baseName: string): Promise<string> => {
  const MAX_LENGTH = 24;
  let normalizedBase = baseName
    .replace(/\.[^.]+$/, '') // strip file extension
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '') // remove non-alphanumeric/underscore
    .replace(/^_+|_+$/g, '') // trim leading/trailing underscores
    .replace(/_+/g, '_'); // collapse multiple underscores

  if (!normalizedBase) {
    normalizedBase = 'emoji';
  }

  if (normalizedBase.length > MAX_LENGTH - 3) {
    normalizedBase = normalizedBase.substring(0, MAX_LENGTH - 3);
  }

  let emojiName = normalizedBase.substring(0, MAX_LENGTH);
  let counter = 1;

  while (await emojiExists(emojiName)) {
    const suffix = `_${counter}`;
    const maxBaseLength = MAX_LENGTH - suffix.length;
    emojiName = `${normalizedBase.substring(0, maxBaseLength)}${suffix}`;
    counter++;
  }

  return emojiName;
};

const getEmojiFileIdByEmojiName = async (
  name: string
): Promise<number | null> => {
  const [result] = await db
    .select({
      fileId: emojis.fileId
    })
    .from(emojis)
    .where(eq(emojis.name, name))
    .limit(1);

  return result ? result.fileId : null;
};

export {
  emojiExists,
  getEmojiById,
  getEmojiFileIdByEmojiName,
  getEmojis,
  getUniqueEmojiName
};
