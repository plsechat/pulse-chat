import type { TFile } from '@pulse/shared';
import type { E2EEPlaintext } from './types';

/**
 * Session-scoped caches for encrypted attachments, both bounded LRUs
 * (a Map in insertion order; a read re-inserts to mark recency).
 *
 *   - `fileKeysMap`: per-message AES keys lifted out of the decrypted
 *     envelope, consumed by `useDecryptedFileUrl` at render time. The
 *     durable copy lives inside the persisted plaintext (the envelope
 *     JSON carries `fileKeys`), so eviction here only costs a cache
 *     miss on the next decrypt. The cap is well above any rendered
 *     window, because an evicted key makes a STILL-MOUNTED attachment
 *     fall back to its encrypted bytes until the message is decrypted
 *     again.
 *   - `blobUrls`: object URLs for already-decrypted blobs. Each one
 *     pins the whole decrypted Blob in memory, so this cap is the
 *     memory bound for a media-heavy encrypted conversation; eviction
 *     revokes the URL and the next mount re-fetches + re-decrypts.
 *
 * Both are wiped by `clearAllStores` (logout) so decrypted media never
 * outlives the identity that could read it.
 */
const MAX_FILE_KEY_ENTRIES = 500;
const MAX_BLOB_URL_ENTRIES = 100;

const fileKeysMap = new Map<number, E2EEPlaintext['fileKeys']>();
const blobUrls = new Map<string, string>();

function touch<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

export function getFileKeys(messageId: number): E2EEPlaintext['fileKeys'] | undefined {
  return touch(fileKeysMap, messageId);
}

export function setFileKeys(messageId: number, keys: E2EEPlaintext['fileKeys']): void {
  if (!keys || keys.length === 0) return;
  fileKeysMap.delete(messageId);
  fileKeysMap.set(messageId, keys);
  while (fileKeysMap.size > MAX_FILE_KEY_ENTRIES) {
    const oldest = fileKeysMap.keys().next().value;
    if (oldest === undefined) break;
    fileKeysMap.delete(oldest);
  }
}

export function clearFileKeys(): void {
  fileKeysMap.clear();
}

function blobUrlKey(messageId: number, fileId: number): string {
  return `${messageId}:${fileId}`;
}

/** The cached object URL for a decrypted attachment, if still held. */
export function getDecryptedFileUrl(
  messageId: number,
  fileId: number
): string | undefined {
  return touch(blobUrls, blobUrlKey(messageId, fileId));
}

/**
 * Remember a freshly created object URL. Evicts (and revokes) the
 * least-recently-used URLs past the cap; a replaced URL for the same
 * attachment is revoked too so the old Blob can be collected.
 */
export function rememberDecryptedFileUrl(
  messageId: number,
  fileId: number,
  url: string
): void {
  const key = blobUrlKey(messageId, fileId);
  const previous = blobUrls.get(key);
  if (previous !== undefined && previous !== url) {
    URL.revokeObjectURL(previous);
  }
  blobUrls.delete(key);
  blobUrls.set(key, url);
  while (blobUrls.size > MAX_BLOB_URL_ENTRIES) {
    const oldest = blobUrls.entries().next().value;
    if (!oldest) break;
    blobUrls.delete(oldest[0]);
    URL.revokeObjectURL(oldest[1]);
  }
}

/** Revoke every held object URL and forget it (logout). */
export function revokeAllDecryptedFileUrls(): void {
  for (const url of blobUrls.values()) {
    URL.revokeObjectURL(url);
  }
  blobUrls.clear();
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
