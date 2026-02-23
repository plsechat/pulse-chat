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
