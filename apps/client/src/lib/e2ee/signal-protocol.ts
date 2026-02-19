import init, {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress
} from '@privacyresearch/libsignal-protocol-typescript';
import { signalStore, type SignalProtocolStore } from './store';
import type { PreKeyBundle } from './types';
import { arrayBufferToBase64, base64ToArrayBuffer } from './utils';

let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  await init();
  initialized = true;
}

/**
 * Generate a new identity (key pair + registration ID + signed pre-key + batch of OTPs).
 * Returns the public portions to upload to the server.
 */
export async function generateKeys(
  oneTimePreKeyCount = 100,
  store?: SignalProtocolStore
) {
  await ensureInitialized();
  const s = store ?? signalStore;

  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();

  await s.saveLocalIdentity(identityKeyPair, registrationId);

  // Generate signed pre-key
  const signedPreKeyId = 1;
  const signedPreKey = await KeyHelper.generateSignedPreKey(
    identityKeyPair,
    signedPreKeyId
  );
  await s.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair);

  // Generate one-time pre-keys
  const oneTimePreKeys: { keyId: number; publicKey: string }[] = [];
  for (let i = 1; i <= oneTimePreKeyCount; i++) {
    const preKey = await KeyHelper.generatePreKey(i);
    await s.storePreKey(i, preKey.keyPair);
    oneTimePreKeys.push({
      keyId: i,
      publicKey: arrayBufferToBase64(preKey.keyPair.pubKey)
    });
  }

  return {
    identityPublicKey: arrayBufferToBase64(identityKeyPair.pubKey),
    registrationId,
    signedPreKey: {
      keyId: signedPreKeyId,
      publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
      signature: arrayBufferToBase64(signedPreKey.signature)
    },
    oneTimePreKeys
  };
}

/**
 * Check if the user has already generated keys.
 */
export async function hasKeys(store?: SignalProtocolStore): Promise<boolean> {
  const s = store ?? signalStore;
  return s.hasLocalIdentity();
}

/**
 * Get the local identity public key (base64).
 */
export async function getIdentityPublicKey(
  store?: SignalProtocolStore
): Promise<string | null> {
  const s = store ?? signalStore;
  const kp = await s.getIdentityKeyPair();
  if (!kp) return null;
  return arrayBufferToBase64(kp.pubKey);
}

/**
 * Build a session with a remote user using their pre-key bundle (X3DH).
 */
export async function buildSession(
  userId: number,
  bundle: PreKeyBundle,
  store?: SignalProtocolStore
): Promise<void> {
  await ensureInitialized();
  const s = store ?? signalStore;

  const address = new SignalProtocolAddress(String(userId), 1);
  const builder = new SessionBuilder(s, address);

  const preKeyBundle = {
    registrationId: bundle.registrationId,
    identityKey: base64ToArrayBuffer(bundle.identityPublicKey),
    signedPreKey: {
      keyId: bundle.signedPreKey.keyId,
      publicKey: base64ToArrayBuffer(bundle.signedPreKey.publicKey),
      signature: base64ToArrayBuffer(bundle.signedPreKey.signature)
    },
    preKey: bundle.oneTimePreKey
      ? {
          keyId: bundle.oneTimePreKey.keyId,
          publicKey: base64ToArrayBuffer(bundle.oneTimePreKey.publicKey)
        }
      : undefined
  };

  await builder.processPreKey(preKeyBundle);
}

/**
 * Check if we have an active session with a user.
 */
export async function hasSession(
  userId: number,
  store?: SignalProtocolStore
): Promise<boolean> {
  const s = store ?? signalStore;
  const address = new SignalProtocolAddress(String(userId), 1);
  const session = await s.loadSession(address.toString());
  return !!session;
}

/**
 * Encrypt a plaintext string for a specific user using the Double Ratchet.
 * Returns a base64-encoded ciphertext object.
 */
export async function encryptMessage(
  userId: number,
  plaintext: string,
  store?: SignalProtocolStore
): Promise<string> {
  await ensureInitialized();
  const s = store ?? signalStore;

  const address = new SignalProtocolAddress(String(userId), 1);
  const cipher = new SessionCipher(s, address);

  const encoder = new TextEncoder();
  const encoded = encoder.encode(plaintext);
  const plaintextBuffer = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  ) as ArrayBuffer;

  const ciphertext = await cipher.encrypt(plaintextBuffer);

  // Serialize the ciphertext for transport
  return JSON.stringify({
    type: ciphertext.type,
    body: ciphertext.body
  });
}

/**
 * Decrypt a ciphertext from a specific user.
 * Returns the plaintext string.
 */
export async function decryptMessage(
  userId: number,
  ciphertextJson: string,
  store?: SignalProtocolStore
): Promise<string> {
  await ensureInitialized();
  const s = store ?? signalStore;

  const address = new SignalProtocolAddress(String(userId), 1);
  const cipher = new SessionCipher(s, address);

  const ciphertext = JSON.parse(ciphertextJson) as {
    type: number;
    body: string;
  };

  let plaintext: ArrayBuffer;

  if (ciphertext.type === 3) {
    // Pre-key message (initial message establishing session)
    plaintext = await cipher.decryptPreKeyWhisperMessage(
      ciphertext.body,
      'binary'
    );
  } else {
    // Normal ratchet message
    plaintext = await cipher.decryptWhisperMessage(
      ciphertext.body,
      'binary'
    );
  }

  const decoder = new TextDecoder();
  return decoder.decode(plaintext);
}

/**
 * Generate additional one-time pre-keys for replenishment.
 */
export async function generateOneTimePreKeys(
  startId: number,
  count: number,
  store?: SignalProtocolStore
) {
  await ensureInitialized();
  const s = store ?? signalStore;

  const keys: { keyId: number; publicKey: string }[] = [];
  for (let i = startId; i < startId + count; i++) {
    const preKey = await KeyHelper.generatePreKey(i);
    await s.storePreKey(i, preKey.keyPair);
    keys.push({
      keyId: i,
      publicKey: arrayBufferToBase64(preKey.keyPair.pubKey)
    });
  }
  return keys;
}

/**
 * Generate a new signed pre-key for rotation.
 */
export async function generateSignedPreKey(
  keyId: number,
  store?: SignalProtocolStore
) {
  await ensureInitialized();
  const s = store ?? signalStore;

  const identityKeyPair = await s.getIdentityKeyPair();
  if (!identityKeyPair) {
    throw new Error('No identity key pair found');
  }

  const signedPreKey = await KeyHelper.generateSignedPreKey(
    identityKeyPair,
    keyId
  );
  await s.storeSignedPreKey(keyId, signedPreKey.keyPair);

  return {
    keyId,
    publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
    signature: arrayBufferToBase64(signedPreKey.signature)
  };
}
