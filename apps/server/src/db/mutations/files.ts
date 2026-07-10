import type { TFile } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import fs from 'fs/promises';
import path from 'path';
import { db } from '..';
import { PUBLIC_PATH } from '../../helpers/paths';
import { logger } from '../../logger';
import { files, messageFiles } from '../schema';

const removeFile = async (fileId: number): Promise<TFile | undefined> => {
  await db.delete(messageFiles).where(eq(messageFiles.fileId, fileId));

  const [removedFile] = await db
    .delete(files)
    .where(eq(files.id, fileId))
    .returning();

  if (removedFile) {
    try {
      const filePath = path.join(PUBLIC_PATH, removedFile.name);

      await fs.unlink(filePath);
      logger.debug(
        '[removeFile] fileId=%d name=%s size=%d',
        fileId,
        removedFile.name,
        removedFile.size
      );
    } catch (error) {
      logger.error('Error deleting file from disk:', error);
    }
  } else {
    logger.debug('[removeFile] no row for fileId=%d', fileId);
  }

  return removedFile;
};

export { removeFile };
