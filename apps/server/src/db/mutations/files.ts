import type { TFile } from '../../types';
import { eq } from 'drizzle-orm';
import fs from 'fs/promises';
import path from 'path';
import { db } from '..';
import { PUBLIC_PATH } from '../../helpers/paths';
import { logger } from '../../logger';
import { invalidateFileAssociation } from '../../utils/file-association-cache';
import { files, messageFiles } from '../schema';

const removeFile = async (fileId: number): Promise<TFile | undefined> => {
  await db.delete(messageFiles).where(eq(messageFiles.fileId, fileId));

  const [removedFile] = await db
    .delete(files)
    .where(eq(files.id, fileId))
    .returning();

  if (removedFile) {
    // /public memoises what a name is attached to; the row is gone, so
    // the next request must miss instead of serving a deleted file.
    invalidateFileAssociation(removedFile.name);

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
