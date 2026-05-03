import { signalStore } from './store';
import { arrayBufferToBase64, base64ToArrayBuffer } from './utils';

// Mirror of sender-keys.ts but operating on DM channels. The crypto
// is identical (AES-256-GCM with 12-byte IV) — the only thing that
// differs is the IDB keying (`dm:${id}:${user}` vs `${id}:${user}`).
// Group DMs always live on the home instance, so these helpers go
// straight to `signalStore` rather than the active-instance store.

const IV_LENGTH = 12;

const cryptoKeyCache = new Map<string, CryptoKey>();

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const cached = cryptoKeyCache.get(keyBase64);
  if (cached) return cached;
  const rawKey = base64ToArrayBuffer(keyBase64);
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  cryptoKeyCache.set(keyBase64, key);
  return key;
}

/**
 * Generate a fresh AES-256-GCM sender key for a DM channel and store
 * it locally as our (ownUserId) outbound key.
 */
export async function generateDmSenderKey(
  dmChannelId: number,
  ownUserId: number
): Promise<string> {
  const cryptoKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const raw = await crypto.subtle.exportKey('raw', cryptoKey);
  const keyBase64 = arrayBufferToBase64(raw);
  await signalStore.storeDmSenderKey(dmChannelId, ownUserId, keyBase64);
  return keyBase64;
}

export async function hasDmSenderKey(
  dmChannelId: number,
  userId: number
): Promise<boolean> {
  const k = await signalStore.getDmSenderKey(dmChannelId, userId);
  return !!k;
}

export async function storeDmSenderKeyForUser(
  dmChannelId: number,
  userId: number,
  keyBase64: string
): Promise<void> {
  await signalStore.storeDmSenderKey(dmChannelId, userId, keyBase64);
}

/**
 * Encrypt with the caller's own sender key for a DM channel.
 * Format: base64(iv || ciphertext).
 */
export async function encryptWithDmSenderKey(
  dmChannelId: number,
  ownUserId: number,
  plaintext: string
): Promise<string> {
  const keyBase64 = await signalStore.getDmSenderKey(dmChannelId, ownUserId);
  if (!keyBase64) {
    throw new Error(`No sender key found for DM channel ${dmChannelId}`);
  }
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LENGTH);
  return arrayBufferToBase64(combined.buffer);
}

/**
 * Decrypt using the named sender's distributed key for this DM channel.
 */
export async function decryptWithDmSenderKey(
  dmChannelId: number,
  fromUserId: number,
  ciphertextBase64: string
): Promise<string> {
  const keyBase64 = await signalStore.getDmSenderKey(dmChannelId, fromUserId);
  if (!keyBase64) {
    throw new Error(
      `No sender key for user ${fromUserId} in DM channel ${dmChannelId}`
    );
  }
  const key = await importKey(keyBase64);
  const combined = new Uint8Array(base64ToArrayBuffer(ciphertextBase64));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Drop crypto-key cache entries — called from finalizeRestoredKeys
 * after IDB has been rewritten wholesale.
 */
export function clearDmCryptoKeyCache(): void {
  cryptoKeyCache.clear();
}
