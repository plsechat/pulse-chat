import { describe, expect, test } from 'bun:test';

/**
 * Pure crypto tests for E2EE key backup.
 *
 * We inline base64 helpers and import-free copies of the crypto functions
 * so the test runs in Bun without IndexedDB or browser-only dependencies.
 */

// --- Inline base64 helpers (same as apps/client/src/lib/e2ee/utils.ts) ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// --- Inline crypto functions (same logic as key-backup.ts) ---

const PBKDF2_ITERATIONS = 600_000;

const STORE_NAMES = [
  'identityKey',
  'registrationId',
  'preKeys',
  'signedPreKeys',
  'sessions',
  'identities'
] as const;

type BackupPayload = {
  version: 1;
  salt: string;
  iv: string;
  ciphertext: string;
};

async function deriveBackupKey(
  passphrase: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptBackupData(
  data: Record<string, unknown[]>,
  passphrase: string
): Promise<BackupPayload> {
  const json = JSON.stringify(data);
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(json);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  return {
    version: 1,
    salt: arrayBufferToBase64(salt.buffer),
    iv: arrayBufferToBase64(iv.buffer),
    ciphertext: arrayBufferToBase64(ciphertext)
  };
}

async function decryptBackupPayload(
  payload: BackupPayload,
  passphrase: string
): Promise<Record<string, unknown[]>> {
  if (payload.version !== 1) {
    throw new Error(`Unsupported backup version: ${payload.version}`);
  }

  if (!payload.salt || !payload.iv || !payload.ciphertext) {
    throw new Error('Backup file is missing required fields');
  }

  const salt = new Uint8Array(base64ToArrayBuffer(payload.salt));
  const iv = new Uint8Array(base64ToArrayBuffer(payload.iv));
  const ciphertext = base64ToArrayBuffer(payload.ciphertext);
  const key = await deriveBackupKey(passphrase, salt);

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
  } catch {
    throw new Error('Wrong passphrase or corrupted backup file');
  }

  const decoder = new TextDecoder();
  const json = decoder.decode(decrypted);
  let data: Record<string, unknown[]>;

  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Decrypted data is not valid JSON');
  }

  for (const storeName of STORE_NAMES) {
    if (!Array.isArray(data[storeName])) {
      throw new Error(`Backup is missing store: ${storeName}`);
    }
  }

  return data;
}

// --- Helpers ---

function makeMockStoreData(): Record<string, unknown[]> {
  return {
    identityKey: [
      { key: 'identityKey', value: { pubKey: 'abc123', privKey: 'xyz789' } }
    ],
    registrationId: [{ key: 'registrationId', value: 42 }],
    preKeys: [
      { key: '1', value: { pubKey: 'pk1pub', privKey: 'pk1priv' } },
      { key: '2', value: { pubKey: 'pk2pub', privKey: 'pk2priv' } }
    ],
    signedPreKeys: [
      { key: '1', value: { pubKey: 'spk1pub', privKey: 'spk1priv' } }
    ],
    sessions: [{ key: 'user1.1', value: { record: 'session-data' } }],
    identities: [{ key: 'user1', value: 'remote-identity-key-base64' }]
  };
}

// --- Tests ---

describe('key-backup crypto', () => {
  const PASSPHRASE = 'test-passphrase-12345';

  test('encrypt then decrypt round-trip preserves data', async () => {
    const original = makeMockStoreData();

    const payload = await encryptBackupData(original, PASSPHRASE);
    const restored = await decryptBackupPayload(payload, PASSPHRASE);

    expect(restored).toEqual(original);
  });

  test('payload has correct structure', async () => {
    const data = makeMockStoreData();
    const payload = await encryptBackupData(data, PASSPHRASE);

    expect(payload.version).toBe(1);
    expect(typeof payload.salt).toBe('string');
    expect(typeof payload.iv).toBe('string');
    expect(typeof payload.ciphertext).toBe('string');

    // Salt should be 16 bytes (base64 length ~24)
    const saltBytes = new Uint8Array(base64ToArrayBuffer(payload.salt));
    expect(saltBytes.length).toBe(16);

    // IV should be 12 bytes
    const ivBytes = new Uint8Array(base64ToArrayBuffer(payload.iv));
    expect(ivBytes.length).toBe(12);
  });

  test('different encryptions produce different salt and iv', async () => {
    const data = makeMockStoreData();
    const payload1 = await encryptBackupData(data, PASSPHRASE);
    const payload2 = await encryptBackupData(data, PASSPHRASE);

    expect(payload1.salt).not.toBe(payload2.salt);
    expect(payload1.iv).not.toBe(payload2.iv);
    expect(payload1.ciphertext).not.toBe(payload2.ciphertext);
  });

  test('wrong passphrase throws descriptive error', async () => {
    const data = makeMockStoreData();
    const payload = await encryptBackupData(data, PASSPHRASE);

    await expect(
      decryptBackupPayload(payload, 'wrong-passphrase')
    ).rejects.toThrow('Wrong passphrase or corrupted backup file');
  });

  test('corrupted ciphertext throws error', async () => {
    const data = makeMockStoreData();
    const payload = await encryptBackupData(data, PASSPHRASE);

    // Corrupt the ciphertext by flipping bits
    const ctBytes = new Uint8Array(base64ToArrayBuffer(payload.ciphertext));
    ctBytes[0] = ctBytes[0]! ^ 0xff;
    const corrupted: BackupPayload = {
      ...payload,
      ciphertext: arrayBufferToBase64(ctBytes.buffer)
    };

    await expect(
      decryptBackupPayload(corrupted, PASSPHRASE)
    ).rejects.toThrow('Wrong passphrase or corrupted backup file');
  });

  test('missing required fields throws error', async () => {
    const incomplete = {
      version: 1 as const,
      salt: 'abc',
      iv: '',
      ciphertext: 'def'
    };

    await expect(
      decryptBackupPayload(incomplete, PASSPHRASE)
    ).rejects.toThrow('Backup file is missing required fields');
  });

  test('missing store in decrypted data throws error', async () => {
    // Encrypt data that is missing the 'sessions' store
    const incomplete: Record<string, unknown[]> = {
      identityKey: [],
      registrationId: [],
      preKeys: [],
      signedPreKeys: [],
      // sessions intentionally omitted
      identities: []
    };

    const payload = await encryptBackupData(incomplete, PASSPHRASE);

    await expect(
      decryptBackupPayload(payload, PASSPHRASE)
    ).rejects.toThrow('Backup is missing store: sessions');
  });

  test('empty stores round-trip correctly', async () => {
    const emptyData: Record<string, unknown[]> = {
      identityKey: [],
      registrationId: [],
      preKeys: [],
      signedPreKeys: [],
      sessions: [],
      identities: []
    };

    const payload = await encryptBackupData(emptyData, PASSPHRASE);
    const restored = await decryptBackupPayload(payload, PASSPHRASE);

    expect(restored).toEqual(emptyData);
  });

  test('deriveBackupKey produces consistent results for same inputs', async () => {
    const salt = new Uint8Array(16);
    salt.fill(42);

    const key1 = await deriveBackupKey(PASSPHRASE, salt);
    const key2 = await deriveBackupKey(PASSPHRASE, salt);

    // Both keys should be AES-GCM CryptoKey objects
    expect(key1.algorithm.name).toBe('AES-GCM');
    expect(key2.algorithm.name).toBe('AES-GCM');

    // Encrypt the same plaintext with both — should produce same result with same IV
    const iv = new Uint8Array(12);
    const plaintext = new TextEncoder().encode('test');

    const ct1 = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key1,
      plaintext
    );
    const ct2 = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key2,
      plaintext
    );

    expect(arrayBufferToBase64(ct1)).toBe(arrayBufferToBase64(ct2));
  });

  test('different salts produce different keys', async () => {
    const salt1 = new Uint8Array(16);
    salt1.fill(1);
    const salt2 = new Uint8Array(16);
    salt2.fill(2);

    const key1 = await deriveBackupKey(PASSPHRASE, salt1);
    const key2 = await deriveBackupKey(PASSPHRASE, salt2);

    const iv = new Uint8Array(12);
    const plaintext = new TextEncoder().encode('test');

    const ct1 = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key1,
      plaintext
    );
    const ct2 = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key2,
      plaintext
    );

    expect(arrayBufferToBase64(ct1)).not.toBe(arrayBufferToBase64(ct2));
  });
});
