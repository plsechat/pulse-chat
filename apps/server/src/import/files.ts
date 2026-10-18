import type { TFile } from '../types';
import fs from 'fs/promises';
import path from 'path';
import { BLOCKED_EXTENSIONS } from '../http/upload';
import { fileManager } from '../utils/file-manager';

/**
 * Store downloaded bytes as a file of `userId`, through the same gates
 * and the same temp-file → saveFile path as an HTTP upload: blocked
 * extensions, the size cap the caller already enforced on the
 * download, the user's and the server's storage quota (saveFile throws
 * on either — the caller records the error and keeps going).
 */

const MAX_FILENAME_LENGTH = 200;

/** Strip directories and control characters; the stored name is a UUID anyway. */
const safeOriginalName = (filename: string, fallbackExt: string): string => {
  const base = Array.from(path.basename(filename))
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join('')
    .slice(0, MAX_FILENAME_LENGTH);
  const hasExtension = /\.[a-z0-9]{1,16}$/i.test(base);

  return base.length > 0 ? (hasExtension ? base : `${base}${fallbackExt}`) : `file${fallbackExt}`;
};

/** Refuse a blocked extension before any bytes are fetched for it. */
const assertAllowedExtension = (filename: string): void => {
  const ext = path.extname(safeOriginalName(filename, '')).toLowerCase();

  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`File type ${ext} is not allowed`);
  }
};

const storeImportedFile = async (
  bytes: Uint8Array,
  filename: string,
  userId: number,
  fallbackExt = ''
): Promise<TFile> => {
  if (bytes.byteLength === 0) {
    throw new Error('Empty file');
  }

  const originalName = safeOriginalName(filename, fallbackExt);
  const ext = path.extname(originalName).toLowerCase();

  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`File type ${ext} is not allowed`);
  }

  const uploadPath = await fileManager.getSafeUploadPath(originalName);
  await fs.writeFile(uploadPath, bytes);

  const temp = await fileManager.addTemporaryFile({
    originalName,
    filePath: uploadPath,
    size: bytes.byteLength,
    userId
  });

  try {
    return await fileManager.saveFile(temp.id, userId);
  } catch (error) {
    await fileManager.removeTemporaryFile(temp.id).catch(() => undefined);
    throw error;
  }
};

export { assertAllowedExtension, storeImportedFile };
