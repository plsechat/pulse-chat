import { StorageOverflowAction, type TTempFile } from '@pulse/shared';
import type { TFile } from '../types';
import { randomUUIDv7 } from 'bun';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { db } from '../db';
import { removeFile } from '../db/mutations/files';
import { getExceedingOldFiles, getUsedFileQuota } from '../db/queries/files';
import { getInstanceServerSettings } from '../db/queries/server';
import { getStorageUsageByUserId } from '../db/queries/users';
import { files } from '../db/schema';
import { PUBLIC_PATH, TMP_PATH, UPLOADS_PATH } from '../helpers/paths';
import { logger } from '../logger';

/**
 * Files workflow:
 * 1. User uploads file via HTTP -> stored as temporary file in UPLOADS_PATH
 * 2. addTemporaryFile is called to move file to a managed temporary location in TMP_PATH
 * 3. Temporary file is tracked and auto-deleted after TTL
 * 4. When user confirms/save, saveFile is called to move file to PUBLIC_PATH and create DB entry
 * 5. Storage limits are checked before finalizing save
 */

/** Standard Node.js-compatible file existence check (replaces Bun-specific fs.exists) */
export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const TEMP_FILE_TTL = 1000 * 60 * 1; // 1 minute

/**
 * Hash through a read stream rather than fs.readFile: uploads can be up
 * to storageUploadMaxFileSize (100 MB by default) and Bun is
 * single-threaded, so buffering the whole file per upload is a
 * needless memory spike under concurrent uploads.
 */
const md5File = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });

/**
 * The extension that survives onto disk (upload area, tmp area, public
 * area) and into files.extension. `path.extname` is otherwise unbounded:
 * a multi-KB "extension" became the on-disk name (ENAMETOOLONG -> 500)
 * and anything outside [a-z0-9] has no business in a served filename.
 * Anything that does not look like a real extension is dropped, which
 * also means the file is served as application/octet-stream.
 */
const SAFE_EXTENSION = /^\.[a-z0-9]{1,16}$/i;

const safeExtension = (originalName: string): string => {
  const ext = path.extname(originalName);

  return SAFE_EXTENSION.test(ext) ? ext.toLowerCase() : '';
};

class TemporaryFileManager {
  private temporaryFiles: TTempFile[] = [];
  private timeouts: {
    [id: string]: NodeJS.Timeout;
  } = {};

  public getTemporaryFile = (id: string): TTempFile | undefined => {
    return this.temporaryFiles.find((file) => file.id === id);
  };

  public temporaryFileExists = (id: string): boolean => {
    return !!this.temporaryFiles.find((file) => file.id === id);
  };

  public addTemporaryFile = async ({
    filePath,
    size,
    originalName,
    userId,
    encrypted = false
  }: {
    filePath: string;
    size: number;
    originalName: string;
    userId: number;
    encrypted?: boolean;
  }): Promise<TTempFile> => {
    const md5 = await md5File(filePath);
    const fileId = randomUUIDv7();
    const ext = safeExtension(originalName);

    const tempFilePath = path.join(TMP_PATH, `${fileId}${ext}`);

    const tempFile: TTempFile = {
      id: fileId,
      originalName,
      size,
      md5,
      path: tempFilePath,
      extension: ext,
      userId,
      encrypted
    };

    await fs.rename(filePath, tempFile.path);

    this.temporaryFiles.push(tempFile);

    this.timeouts[tempFile.id] = setTimeout(() => {
      this.removeTemporaryFile(tempFile.id);
    }, TEMP_FILE_TTL);

    return tempFile;
  };

  public removeTemporaryFile = async (
    id: string,
    skipDelete = false
  ): Promise<void> => {
    const tempFile = this.temporaryFiles.find((file) => file.id === id);

    if (!tempFile) {
      throw new Error('Temporary file not found');
    }

    clearTimeout(this.timeouts[id]);
    delete this.timeouts[id];

    if (!skipDelete) {
      try {
        await fs.unlink(tempFile.path);
      } catch {
        // ignore
      }
    }

    this.temporaryFiles = this.temporaryFiles.filter((file) => file.id !== id);
  };

  public getSafeUploadPath = async (name: string): Promise<string> => {
    await this.sweepStaleFilesOnce();

    const ext = safeExtension(name);
    const safePath = path.join(UPLOADS_PATH, `${randomUUIDv7()}${ext}`);

    return safePath;
  };

  /**
   * Temporary files are tracked in memory with a 1-minute TTL timer, so
   * a restart or crash leaves every in-flight upload (UPLOADS_PATH) and
   * unclaimed temp file (TMP_PATH) on disk forever. This removes
   * everything in both areas that this process is not tracking. It runs
   * once per process, before the first upload touches disk, so at that
   * point the only untracked entries are leftovers from a previous
   * process. It is also safe to call eagerly at boot.
   */
  public sweepStaleFiles = async (): Promise<number> => {
    const tracked = new Set(this.temporaryFiles.map((file) => file.path));
    let removed = 0;

    for (const dir of [UPLOADS_PATH, TMP_PATH]) {
      let entries: string[];

      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryPath = path.join(dir, entry);

        if (tracked.has(entryPath)) continue;

        try {
          await fs.rm(entryPath, { recursive: true, force: true });
          removed++;
        } catch (error) {
          logger.warn(
            '[fileManager] could not remove stale %s: %o',
            entryPath,
            error
          );
        }
      }
    }

    if (removed > 0) {
      logger.info(
        '[fileManager] removed %d stale upload/temp file(s)',
        removed
      );
    }

    return removed;
  };

  private sweepPromise: Promise<number> | undefined;

  private sweepStaleFilesOnce = (): Promise<number> => {
    this.sweepPromise ??= this.sweepStaleFiles().catch((error) => {
      logger.warn('[fileManager] stale file sweep failed: %o', error);
      return 0;
    });

    return this.sweepPromise;
  };
}

type TStorageSnapshot = {
  settings: Awaited<ReturnType<typeof getInstanceServerSettings>>;
  userStorage: number;
  serverStorage: number;
};

class FileManager {
  private tempFileManager = new TemporaryFileManager();

  public getSafeUploadPath = this.tempFileManager.getSafeUploadPath;

  public addTemporaryFile = this.tempFileManager.addTemporaryFile;

  public removeTemporaryFile = this.tempFileManager.removeTemporaryFile;

  public getTemporaryFile = this.tempFileManager.getTemporaryFile;
  public temporaryFileExists = this.tempFileManager.temporaryFileExists;
  public sweepStaleFiles = this.tempFileManager.sweepStaleFiles;

  private readStorage = async (userId: number): Promise<TStorageSnapshot> => {
    const [settings, userStorage, serverStorage] = await Promise.all([
      getInstanceServerSettings(),
      getStorageUsageByUserId(userId),
      getUsedFileQuota()
    ]);

    return { settings, userStorage: userStorage.usedStorage, serverStorage };
  };

  private evaluateStorage = (
    { settings, userStorage, serverStorage }: TStorageSnapshot,
    size: number
  ): 'user' | 'server' | 'delete-old' | undefined => {
    if (
      settings.storageSpaceQuotaByUser > 0 &&
      userStorage + size > settings.storageSpaceQuotaByUser
    ) {
      return 'user';
    }

    if (
      settings.storageQuota > 0 &&
      serverStorage + size > settings.storageQuota
    ) {
      return settings.storageOverflowAction ===
        StorageOverflowAction.DELETE_OLD_FILES
        ? 'delete-old'
        : 'server';
    }

    return undefined;
  };

  /**
   * Quota pre-check for the upload intake: the reason a `size`-byte file
   * for `userId` must be refused BEFORE any bytes hit disk, or undefined
   * when it may proceed. A server overflow under DELETE_OLD_FILES is not
   * a refusal — saveFile frees the space for it.
   */
  public getStorageViolation = async (
    userId: number,
    size: number
  ): Promise<'user' | 'server' | undefined> => {
    const verdict = this.evaluateStorage(await this.readStorage(userId), size);

    return verdict === 'user' || verdict === 'server' ? verdict : undefined;
  };

  private handleStorageLimits = async (tempFile: TTempFile) => {
    const verdict = this.evaluateStorage(
      await this.readStorage(tempFile.userId),
      tempFile.size
    );

    if (verdict === 'user') {
      throw new Error('User storage limit exceeded');
    }

    if (verdict === 'server') {
      throw new Error('Server storage limit exceeded.');
    }

    if (verdict === 'delete-old') {
      const filesToDelete = await getExceedingOldFiles(tempFile.size);

      const promises = filesToDelete.map(async (file) => {
        await removeFile(file.id);
      });

      await Promise.all(promises);
    }
  };

  /**
   * The on-disk / served name for a stored file. Deliberately a random
   * UUID (keeping only the extension) rather than the user's original
   * filename: files are served from a public route addressed by this
   * name, so a predictable name (e.g. "screenshot.png") let anyone
   * guess/enumerate other users' uploads. The real name is preserved in
   * files.originalName for display and the download Content-Disposition.
   * randomUUIDv7 collisions are not a practical concern, but the unique
   * index on files.name is the backstop.
   */
  private getUniqueName = (originalName: string): string => {
    return `${randomUUIDv7()}${safeExtension(originalName)}`;
  };

  public async saveFile(tempFileId: string, userId: number): Promise<TFile> {
    const tempFile = this.getTemporaryFile(tempFileId);

    if (!tempFile) {
      throw new Error('File not found');
    }

    if (tempFile.userId !== userId) {
      throw new Error("You don't have permission to access this file");
    }

    await this.handleStorageLimits(tempFile);

    const fileName = this.getUniqueName(tempFile.originalName);
    const destinationPath = path.join(PUBLIC_PATH, fileName);

    await fs.rename(tempFile.path, destinationPath);
    await this.removeTemporaryFile(tempFileId, true);

    logger.debug(
      '[fileManager] saveFile userId=%d size=%d encrypted=%s name=%s',
      userId,
      tempFile.size,
      !!tempFile.encrypted,
      fileName
    );

    const bunFile = Bun.file(destinationPath);

    // Encrypted uploads come in with placeholder metadata
    // (`originalName = "<uuid>.bin"`, ext = ".bin", upload Content-Type
    // = application/octet-stream). The real values live encrypted
    // inside the E2EE message envelope's fileKeys and are decrypted
    // client-side. We persist the placeholders as-is so the server
    // never holds the real names/types.
    const [file] = await db
      .insert(files)
      .values({
        name: fileName,
        extension: tempFile.extension,
        md5: tempFile.md5,
        size: tempFile.size,
        originalName: tempFile.originalName,
        userId,
        mimeType: tempFile.encrypted
          ? 'application/octet-stream'
          : bunFile?.type || 'application/octet-stream',
        encrypted: tempFile.encrypted ?? false,
        createdAt: Date.now()
      })
      .returning();

    return file!;
  }
}

const fileManager = new FileManager();

export { fileManager, safeExtension };
