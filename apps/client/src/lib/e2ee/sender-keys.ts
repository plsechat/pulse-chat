import { signalStore, type SignalProtocolStore } from './store';
import { arrayBufferToBase64, base64ToArrayBuffer } from './utils';

const IV_LENGTH = 12;

/**
 * Generate a new AES-256-GCM sender key for a channel and store it locally.
 * Returns the raw key as a base64 string.
 */
export async function generateSenderKey(
  channelId: number,
  ownUserId: number,
  store?: SignalProtocolStore
): Promise<string> {
  const s = store ?? signalStore;

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const rawKey = await crypto.subtle.exportKey('raw', key);
  const keyBase64 = arrayBufferToBase64(rawKey);

  await s.storeSenderKey(channelId, ownUserId, keyBase64);
  return keyBase64;
}

/**
 * Check if we have our own sender key for a channel.
 */
export async function hasSenderKey(
  channelId: number,
  userId: number,
  store?: SignalProtocolStore
): Promise<boolean> {
  const s = store ?? signalStore;
  const key = await s.getSenderKey(channelId, userId);
  return !!key;
}

/**
 * Store a received sender key for a specific user/channel.
 */
export async function storeSenderKeyForUser(
  channelId: number,
  userId: number,
  keyBase64: string,
  store?: SignalProtocolStore
): Promise<void> {
  const s = store ?? signalStore;
  await s.storeSenderKey(channelId, userId, keyBase64);
}

/**
 * Cache imported CryptoKey objects so we don't call importKey
 * repeatedly for the same sender key (e.g. 50 messages from one user).
 */
const cryptoKeyCache = new Map<string, CryptoKey>();

/**
 * Import a base64 key string as a CryptoKey (cached).
 */
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
 * Encrypt plaintext using the sender's own key for a channel.
 * Format: base64(iv || ciphertext)
 */
export async function encryptWithSenderKey(
  channelId: number,
  ownUserId: number,
  plaintext: string,
  store?: SignalProtocolStore
): Promise<string> {
  const s = store ?? signalStore;
  const keyBase64 = await s.getSenderKey(channelId, ownUserId);
  if (!keyBase64) {
    throw new Error(`No sender key found for channel ${channelId}`);
  }

  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoder = new TextEncoder();
  const encoded = encoder.encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  // Combine IV + ciphertext
  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LENGTH);

  return arrayBufferToBase64(combined.buffer);
}

/**
 * Decrypt ciphertext using a specific sender's key for a channel.
 * Expects format: base64(iv || ciphertext)
 */
export async function decryptWithSenderKey(
  channelId: number,
  fromUserId: number,
  ciphertextBase64: string,
  store?: SignalProtocolStore
): Promise<string> {
  const s = store ?? signalStore;
  const keyBase64 = await s.getSenderKey(channelId, fromUserId);
  if (!keyBase64) {
    throw new Error(
      `No sender key found for user ${fromUserId} in channel ${channelId}`
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

  const decoder = new TextDecoder();
  return decoder.decode(plaintext);
}
