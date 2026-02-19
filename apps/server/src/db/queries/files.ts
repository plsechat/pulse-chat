import type { TFile } from '@pulse/shared';
import { asc, eq, sql, sum } from 'drizzle-orm';
import { db } from '..';
import { generateFileToken } from '../../helpers/files-crypto';
import { channels, files, messageFiles, messages } from '../schema';
import { getSettings } from './server';

const getExceedingOldFiles = async (newFileSize: number) => {
  const { storageUploadMaxFileSize } = await getSettings();

  if (newFileSize > storageUploadMaxFileSize) {
    throw new Error('File size exceeds total server storage quota');
  }

  const [currentUsage] = await db
    .select({
      totalSize: sum(files.size)
    })
    .from(files)
    .limit(1);

  const currentTotalSize = Number(currentUsage?.totalSize ?? 0);
  const wouldExceedBy =
    currentTotalSize + newFileSize - storageUploadMaxFileSize;

  if (wouldExceedBy <= 0) {
    return [];
  }

  const oldFiles = await db
    .select({
      id: files.id,
      name: files.name,
      size: files.size,
      userId: files.userId,
      createdAt: files.createdAt
    })
    .from(files)
    .orderBy(asc(files.createdAt));

  const filesToDelete = [];
  let freedSpace = 0;

  for (const file of oldFiles) {
    filesToDelete.push(file);
    freedSpace += file.size;

    if (freedSpace >= wouldExceedBy) {
      break;
    }
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

const getFilesByUserId = async (userId: number): Promise<TFile[]> => {
  const result = await db
    .select({
      file: files,
      channel: channels
    })
    .from(files)
    .leftJoin(messageFiles, eq(files.id, messageFiles.fileId))
    .leftJoin(messages, eq(messageFiles.messageId, messages.id))
    .leftJoin(channels, eq(messages.channelId, channels.id))
    .where(eq(files.userId, userId));

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
