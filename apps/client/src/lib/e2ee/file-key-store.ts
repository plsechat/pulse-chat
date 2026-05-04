import type { TFile } from '@pulse/shared';
import type { E2EEPlaintext } from './types';

/**
 * In-memory store for decrypted file encryption keys.
 * Keyed by message ID — populated during message decryption,
 * consumed during file rendering/download.
 */
const fileKeysMap = new Map<number, E2EEPlaintext['fileKeys']>();

export function getFileKeys(messageId: number): E2EEPlaintext['fileKeys'] | undefined {
  return fileKeysMap.get(messageId);
}

export function setFileKeys(messageId: number, keys: E2EEPlaintext['fileKeys']): void {
  if (keys && keys.length > 0) {
    fileKeysMap.set(messageId, keys);
  }
}

/**
 * For E2EE messages with encrypted-file attachments, the server stores
 * placeholder metadata: random `<uuid>.bin` `originalName`, `.bin`
 * extension, `application/octet-stream` mimeType. The real values
 * travel encrypted inside the message envelope as fileKeys.
 *
 * This patch runs at decrypt time so render code never has to know
 * about the placeholder/real split — by the time a file reaches a
 * `<MediaFile>` or `<FileCard>`, its `originalName`/`extension`/
 * `mimeType` are already the real values.
 *
 * Returns the original array unchanged when no patching is needed
 * (non-e2ee message, no fileKeys, or pre-E8 fileKeys missing the
 * metadata fields).
 */
export function patchFilesWithE2eeMetadata(
  files: TFile[],
  fileKeys: E2EEPlaintext['fileKeys']
): TFile[] {
  if (!fileKeys || fileKeys.length === 0) return files;
  let mutated = false;
  const next = files.map((file, idx) => {
    const meta = fileKeys[idx];
    if (!meta?.originalName) return file;
    mutated = true;
    return {
      ...file,
      originalName: meta.originalName,
      extension: meta.extension ?? file.extension,
      mimeType: meta.mimeType ?? file.mimeType
    };
  });
  return mutated ? next : files;
}
