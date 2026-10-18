import type { TFile } from '../types';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { getDmChannelIdByFileId } from '../db/queries/dms';
import { isFileOrphaned } from '../db/queries/files';
import { getMessageByFileId } from '../db/queries/messages';
import { files } from '../db/schema';

/**
 * What a stored file is attached to, as /public needs it to decide the
 * access check: a server-channel message (gated when the channel is
 * private), a DM message (always gated) or profile/emoji/logo media
 * (public). The orphan check is folded in — a file nothing references
 * has no association and is a 404.
 */
type TFileAssociation =
  | { dbFile: TFile; kind: 'public' }
  | { dbFile: TFile; kind: 'channel'; channelId: number }
  | { dbFile: TFile; kind: 'dm'; dmChannelId: number };

/**
 * Resolving the association costs three to four round-trips — the
 * files row, an 11-subquery orphan check and one or two link lookups —
 * and every avatar, emoji and attachment render on every client pays
 * it. The association of a file never changes while the row exists
 * (links are only ever created with the row or removed with it), so
 * memoising it for a minute is safe as long as removeFile drops the
 * entry. Whether a private channel still accepts a token is NOT part
 * of the entry: the channel row (private flag + salt) is read fresh per
 * request so a rotation bites immediately.
 *
 * Only positive results are kept: a freshly uploaded file is linked
 * right after its row appears, and caching the "orphan" answer from a
 * request that raced that gap would hide it for a minute.
 */
const FILE_ASSOCIATION_TTL_MS = 60 * 1000;
const FILE_ASSOCIATION_MAX_ENTRIES = 5000;

const cache = new Map<
  string,
  { expiresAt: number; association: TFileAssociation }
>();

const resolveFileAssociation = async (
  fileName: string
): Promise<TFileAssociation | undefined> => {
  const [dbFile] = await db
    .select()
    .from(files)
    .where(eq(files.name, fileName))
    .limit(1);

  if (!dbFile) return undefined;

  if (await isFileOrphaned(dbFile.id)) return undefined;

  const message = await getMessageByFileId(dbFile.id);

  if (message) {
    return { dbFile, kind: 'channel', channelId: message.channelId };
  }

  const dmChannelId = await getDmChannelIdByFileId(dbFile.id);

  if (dmChannelId !== undefined) {
    return { dbFile, kind: 'dm', dmChannelId };
  }

  return { dbFile, kind: 'public' };
};

const getFileAssociation = async (
  fileName: string
): Promise<TFileAssociation | undefined> => {
  const now = Date.now();
  const hit = cache.get(fileName);

  if (hit) {
    if (hit.expiresAt > now) return hit.association;
    cache.delete(fileName);
  }

  const association = await resolveFileAssociation(fileName);

  if (!association) return undefined;

  // Bounded: a crawler walking random names could not grow it anyway
  // (misses are not stored), but a large real library should not pin
  // every row in memory either. Map iteration is insertion order, so
  // the first key is the oldest entry.
  if (cache.size >= FILE_ASSOCIATION_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;

    if (oldest !== undefined) cache.delete(oldest);
  }

  cache.set(fileName, {
    expiresAt: now + FILE_ASSOCIATION_TTL_MS,
    association
  });

  return association;
};

const invalidateFileAssociation = (fileName: string): void => {
  cache.delete(fileName);
};

export { getFileAssociation, invalidateFileAssociation };
