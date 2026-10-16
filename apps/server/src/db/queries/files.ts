import type { TFile } from '../../types';
import { and, asc, eq, gt, or, sql, sum } from 'drizzle-orm';
import { db } from '..';
import { generateFileToken } from '../../helpers/files-crypto';
import { channels, files, messageFiles, messages } from '../schema';
import { getInstanceServerSettings } from './server';

/**
 * Oldest files to delete so that `newFileSize` more bytes fit under the
 * instance storage quota (DELETE_OLD_FILES overflow mode). Walks the
 * files table oldest-first in bounded batches with a running sum, so a
 * store of millions of rows never gets loaded into memory to free a few
 * MB. A quota of 0 means unlimited: nothing is ever freed.
 */
const EXCEEDING_FILES_BATCH = 500;

const getExceedingOldFiles = async (newFileSize: number) => {
  const { storageQuota, storageUploadMaxFileSize } =
    await getInstanceServerSettings();

  if (newFileSize > storageUploadMaxFileSize) {
    throw new Error('File size exceeds the maximum allowed file size');
  }

  if (storageQuota <= 0) {
    return [];
  }

  if (newFileSize > storageQuota) {
    throw new Error('File size exceeds total server storage quota');
  }

  const currentTotalSize = await getUsedFileQuota();
  const wouldExceedBy = currentTotalSize + newFileSize - storageQuota;

  if (wouldExceedBy <= 0) {
    return [];
  }

  const filesToDelete: {
    id: number;
    name: string;
    size: number;
    userId: number;
    createdAt: number;
  }[] = [];
  let freedSpace = 0;
  // Keyset cursor over (created_at, id) — stable under concurrent
  // inserts, unlike OFFSET pagination.
  let cursor: { createdAt: number; id: number } | undefined;

  while (freedSpace < wouldExceedBy) {
    const batch = await db
      .select({
        id: files.id,
        name: files.name,
        size: files.size,
        userId: files.userId,
        createdAt: files.createdAt
      })
      .from(files)
      .where(
        cursor
          ? or(
              gt(files.createdAt, cursor.createdAt),
              and(eq(files.createdAt, cursor.createdAt), gt(files.id, cursor.id))
            )
          : undefined
      )
      .orderBy(asc(files.createdAt), asc(files.id))
      .limit(EXCEEDING_FILES_BATCH);

    if (batch.length === 0) break;

    for (const file of batch) {
      filesToDelete.push(file);
      freedSpace += file.size;

      if (freedSpace >= wouldExceedBy) break;
    }

    const last = batch[batch.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  return filesToDelete;
};

const getFilesByMessageId = async (messageId: number): Promise<TFile[]> => {
  const rows = await db
    .select()
    .from(messageFiles)
    .innerJoin(files, eq(messageFiles.fileId, files.id))
    .where(eq(messageFiles.messageId, messageId));

  return rows.map((row) => row.files);
};

/** Mod-view listing — strictly the files attached in ONE server's
 * channels (excludes avatars/banners/DM uploads, which have no channel). */
const getFilesByUserId = async (
  userId: number,
  serverId: number
): Promise<TFile[]> => {
  const result = await db
    .select({
      file: files,
      channel: channels
    })
    .from(files)
    .leftJoin(messageFiles, eq(files.id, messageFiles.fileId))
    .leftJoin(messages, eq(messageFiles.messageId, messages.id))
    .leftJoin(channels, eq(messages.channelId, channels.id))
    .where(and(eq(files.userId, userId), eq(channels.serverId, serverId)));

  const results = result.map((r) => {
    const rowCopy: TFile = { ...r.file };

    if (r.channel?.private) {
      rowCopy._accessToken = generateFileToken(
        r.file.id,
        r.channel.fileAccessToken
      );
    }

    return rowCopy;
  });

  return results;
};

const getUsedFileQuota = async (): Promise<number> => {
  const [result] = await db
    .select({
      usedSpace: sum(files.size)
    })
    .from(files)
    .limit(1);

  return Number(result?.usedSpace ?? 0);
};

const getOrphanedFileIds = async (): Promise<number[]> => {
  const orphanedFileIds = await db.execute<{ id: number }>(sql`
    SELECT f.id
    FROM files f
    WHERE NOT EXISTS (
      SELECT 1 FROM message_files mf WHERE mf.file_id = f.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM dm_message_files dmf WHERE dmf.file_id = f.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM users u WHERE u.avatar_id = f.id OR u.banner_id = f.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM emojis e WHERE e.file_id = f.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM message_reactions mr WHERE mr.file_id = f.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM dm_message_reactions dmr WHERE dmr.file_id = f.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM servers srv WHERE srv.logo_id = f.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM settings s WHERE s.logo_id = f.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM nameplates np WHERE np.file_id = f.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM webhooks w WHERE w.avatar_file_id = f.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM dm_channels dc WHERE dc.icon_file_id = f.id
    )
  `);

  return orphanedFileIds.map(({ id }) => id);
};

const isFileOrphaned = async (fileId: number): Promise<boolean> => {
  const result = await db.execute(sql`
    SELECT
      CASE
        WHEN NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = ${fileId})
        AND NOT EXISTS (SELECT 1 FROM dm_message_files dmf WHERE dmf.file_id = ${fileId})
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_id = ${fileId} OR u.banner_id = ${fileId})
        AND NOT EXISTS (SELECT 1 FROM emojis e WHERE e.file_id = ${fileId})
        AND NOT EXISTS (SELECT 1 FROM message_reactions mr WHERE mr.file_id = ${fileId})
        AND NOT EXISTS (SELECT 1 FROM dm_message_reactions dmr WHERE dmr.file_id = ${fileId})
        AND NOT EXISTS (SELECT 1 FROM servers srv WHERE srv.logo_id = ${fileId})
        AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.logo_id = ${fileId})
        AND NOT EXISTS (SELECT 1 FROM nameplates np WHERE np.file_id = ${fileId})
        AND NOT EXISTS (SELECT 1 FROM webhooks w WHERE w.avatar_file_id = ${fileId})
        AND NOT EXISTS (SELECT 1 FROM dm_channels dc WHERE dc.icon_file_id = ${fileId})
        THEN true
        ELSE false
      END as "isOrphaned"
  `);

  return result[0]?.isOrphaned === true;
};

export {
  getExceedingOldFiles,
  getFilesByMessageId,
  getFilesByUserId,
  getOrphanedFileIds,
  getUsedFileQuota,
  isFileOrphaned
};
