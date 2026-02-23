import { describe, expect, test } from 'bun:test';

/**
 * Pure crypto tests for E2EE file encryption.
 *
 * Inlines base64 helpers and crypto functions from the client
 * so the test runs in Bun without browser-only dependencies.
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

// --- Inline file crypto functions (same logic as apps/client/src/lib/e2ee/file-crypto.ts) ---

async function encryptFile(
  file: File
): Promise<{ encryptedBlob: Blob; key: string; nonce: string }> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const fileBuffer = await file.arrayBuffer();

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    fileBuffer
  );

  const exportedKey = await crypto.subtle.exportKey('raw', key);

  return {
    encryptedBlob: new Blob([encrypted], { type: 'application/octet-stream' }),
    key: arrayBufferToBase64(exportedKey),
    nonce: arrayBufferToBase64(nonce.buffer)
  };
}

async function decryptFile(
  encryptedData: ArrayBuffer,
  keyBase64: string,
  nonceBase64: string,
  mimeType: string
): Promise<Blob> {
  const keyBuffer = base64ToArrayBuffer(keyBase64);
  const nonce = base64ToArrayBuffer(nonceBase64);

  const key = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    encryptedData
  );

  return new Blob([decrypted], { type: mimeType });
}

// --- Inline file key store (same logic as apps/client/src/lib/e2ee/file-key-store.ts) ---

type FileKeyEntry = {
  fileId: string;
  key: string;
  nonce: string;
  mimeType: string;
};

function createFileKeyStore() {
  const map = new Map<number, FileKeyEntry[]>();

  return {
    get(messageId: number): FileKeyEntry[] | undefined {
      return map.get(messageId);
    },
    set(messageId: number, keys: FileKeyEntry[] | undefined): void {
      if (keys && keys.length > 0) {
        map.set(messageId, keys);
      }
    },
    clear() {
      map.clear();
    }
  };
}

// --- Tests ---

describe('file encryption crypto', () => {
  test('encrypt then decrypt round-trip preserves file content', async () => {
    const originalContent = 'Hello, this is a test file with some content!';
    const file = new File([originalContent], 'test.txt', {
      type: 'text/plain'
    });

    const { encryptedBlob, key, nonce } = await encryptFile(file);
    const encryptedData = await encryptedBlob.arrayBuffer();

    const decryptedBlob = await decryptFile(
      encryptedData,
      key,
      nonce,
      'text/plain'
    );

    const decryptedText = await decryptedBlob.text();
    expect(decryptedText).toBe(originalContent);
  });

  test('encrypted blob type is application/octet-stream', async () => {
    const file = new File(['test'], 'image.png', { type: 'image/png' });

    const { encryptedBlob } = await encryptFile(file);

    expect(encryptedBlob.type).toBe('application/octet-stream');
  });

  test('decrypted blob has the correct mime type', async () => {
    const file = new File(['test'], 'image.png', { type: 'image/png' });

    const { encryptedBlob, key, nonce } = await encryptFile(file);
    const decryptedBlob = await decryptFile(
      await encryptedBlob.arrayBuffer(),
      key,
      nonce,
      'image/png'
    );

    expect(decryptedBlob.type).toBe('image/png');
  });

  test('encrypted data differs from original', async () => {
    const content = 'This should be encrypted';
    const file = new File([content], 'test.txt', { type: 'text/plain' });

    const { encryptedBlob } = await encryptFile(file);
    const encryptedText = await encryptedBlob.text();

    expect(encryptedText).not.toBe(content);
  });

  test('encrypted data is larger than original (GCM auth tag)', async () => {
    const content = 'Short';
    const file = new File([content], 'test.txt', { type: 'text/plain' });

    const { encryptedBlob } = await encryptFile(file);

    // AES-GCM adds a 16-byte auth tag
    expect(encryptedBlob.size).toBe(content.length + 16);
  });

  test('each encryption produces different key and nonce', async () => {
    const file = new File(['same content'], 'test.txt', {
      type: 'text/plain'
    });

    const result1 = await encryptFile(file);
    const result2 = await encryptFile(file);

    expect(result1.key).not.toBe(result2.key);
    expect(result1.nonce).not.toBe(result2.nonce);
  });

  test('key is 256-bit (32 bytes base64)', async () => {
    const file = new File(['test'], 'test.txt', { type: 'text/plain' });

    const { key } = await encryptFile(file);
    const keyBytes = base64ToArrayBuffer(key);

    expect(keyBytes.byteLength).toBe(32);
  });

  test('nonce is 96-bit (12 bytes base64)', async () => {
    const file = new File(['test'], 'test.txt', { type: 'text/plain' });

    const { nonce } = await encryptFile(file);
    const nonceBytes = base64ToArrayBuffer(nonce);

    expect(nonceBytes.byteLength).toBe(12);
  });

  test('wrong key fails to decrypt', async () => {
    const file = new File(['secret data'], 'test.txt', {
      type: 'text/plain'
    });

    const { encryptedBlob, nonce } = await encryptFile(file);

    // Generate a different key
    const wrongKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const wrongKeyBase64 = arrayBufferToBase64(
      await crypto.subtle.exportKey('raw', wrongKey)
    );

    await expect(
      decryptFile(
        await encryptedBlob.arrayBuffer(),
        wrongKeyBase64,
        nonce,
        'text/plain'
      )
    ).rejects.toThrow();
  });

  test('wrong nonce fails to decrypt', async () => {
    const file = new File(['secret data'], 'test.txt', {
      type: 'text/plain'
    });

    const { encryptedBlob, key } = await encryptFile(file);

    // Generate a different nonce
    const wrongNonce = crypto.getRandomValues(new Uint8Array(12));
    const wrongNonceBase64 = arrayBufferToBase64(wrongNonce.buffer);

    await expect(
      decryptFile(
        await encryptedBlob.arrayBuffer(),
        key,
        wrongNonceBase64,
        'text/plain'
      )
    ).rejects.toThrow();
  });

  test('corrupted ciphertext fails to decrypt', async () => {
    const file = new File(['secret data'], 'test.txt', {
      type: 'text/plain'
    });

    const { encryptedBlob, key, nonce } = await encryptFile(file);
    const encryptedBytes = new Uint8Array(await encryptedBlob.arrayBuffer());

    // Flip bits in the ciphertext
    encryptedBytes[0] = encryptedBytes[0]! ^ 0xff;

    await expect(
      decryptFile(encryptedBytes.buffer, key, nonce, 'text/plain')
    ).rejects.toThrow();
  });

  test('round-trip preserves binary file content', async () => {
    // Create a file with binary data (simulating an image)
    const binaryData = crypto.getRandomValues(new Uint8Array(1024));
    const file = new File([binaryData], 'photo.jpg', {
      type: 'image/jpeg'
    });

    const { encryptedBlob, key, nonce } = await encryptFile(file);
    const decryptedBlob = await decryptFile(
      await encryptedBlob.arrayBuffer(),
      key,
      nonce,
      'image/jpeg'
    );

    const decryptedBytes = new Uint8Array(await decryptedBlob.arrayBuffer());
    expect(decryptedBytes).toEqual(binaryData);
  });

  test('round-trip preserves empty file', async () => {
    const file = new File([], 'empty.bin', {
      type: 'application/octet-stream'
    });

    const { encryptedBlob, key, nonce } = await encryptFile(file);
    const decryptedBlob = await decryptFile(
      await encryptedBlob.arrayBuffer(),
      key,
      nonce,
      'application/octet-stream'
    );

    expect(decryptedBlob.size).toBe(0);
  });

  test('round-trip preserves large file', async () => {
    // 1 MB of random data
    const largeData = crypto.getRandomValues(new Uint8Array(1024 * 1024));
    const file = new File([largeData], 'large.bin', {
      type: 'application/octet-stream'
    });

    const { encryptedBlob, key, nonce } = await encryptFile(file);
    const decryptedBlob = await decryptFile(
      await encryptedBlob.arrayBuffer(),
      key,
      nonce,
      'application/octet-stream'
    );

    const decryptedBytes = new Uint8Array(await decryptedBlob.arrayBuffer());
    expect(decryptedBytes).toEqual(largeData);
  });
});

describe('file key store', () => {
  test('get returns undefined for unknown message', () => {
    const store = createFileKeyStore();
    expect(store.get(999)).toBeUndefined();
  });

  test('set and get round-trip', () => {
    const store = createFileKeyStore();
    const keys: FileKeyEntry[] = [
      { fileId: 'abc', key: 'k1', nonce: 'n1', mimeType: 'image/png' }
    ];

    store.set(1, keys);
    expect(store.get(1)).toEqual(keys);
  });

  test('set ignores undefined keys', () => {
    const store = createFileKeyStore();
    store.set(1, undefined);
    expect(store.get(1)).toBeUndefined();
  });

  test('set ignores empty array', () => {
    const store = createFileKeyStore();
    store.set(1, []);
    expect(store.get(1)).toBeUndefined();
  });

  test('stores multiple file keys per message', () => {
    const store = createFileKeyStore();
    const keys: FileKeyEntry[] = [
      { fileId: 'f1', key: 'k1', nonce: 'n1', mimeType: 'image/png' },
      { fileId: 'f2', key: 'k2', nonce: 'n2', mimeType: 'video/mp4' },
      { fileId: 'f3', key: 'k3', nonce: 'n3', mimeType: 'text/plain' }
    ];

    store.set(42, keys);

    const retrieved = store.get(42);
    expect(retrieved).toHaveLength(3);
    expect(retrieved![0]!.fileId).toBe('f1');
    expect(retrieved![2]!.mimeType).toBe('text/plain');
  });

  test('different messages have independent keys', () => {
    const store = createFileKeyStore();

    store.set(1, [
      { fileId: 'a', key: 'ka', nonce: 'na', mimeType: 'image/png' }
    ]);
    store.set(2, [
      { fileId: 'b', key: 'kb', nonce: 'nb', mimeType: 'video/mp4' }
    ]);

    expect(store.get(1)![0]!.fileId).toBe('a');
    expect(store.get(2)![0]!.fileId).toBe('b');
  });

  test('overwriting a message replaces keys', () => {
    const store = createFileKeyStore();

    store.set(1, [
      { fileId: 'old', key: 'k1', nonce: 'n1', mimeType: 'text/plain' }
    ]);
    store.set(1, [
      { fileId: 'new', key: 'k2', nonce: 'n2', mimeType: 'image/jpeg' }
    ]);

    expect(store.get(1)![0]!.fileId).toBe('new');
  });
});

describe('file encryption E2EE payload integration', () => {
  test('fileKeys contain all required fields after encryption', async () => {
    const file1 = new File(['image data'], 'photo.jpg', {
      type: 'image/jpeg'
    });
    const file2 = new File(['document'], 'doc.pdf', {
      type: 'application/pdf'
    });

    const result1 = await encryptFile(file1);
    const result2 = await encryptFile(file2);

    // Simulate building fileKeys as done in the send path
    const fileKeys: FileKeyEntry[] = [
      {
        fileId: 'temp-1',
        key: result1.key,
        nonce: result1.nonce,
        mimeType: 'image/jpeg'
      },
      {
        fileId: 'temp-2',
        key: result2.key,
        nonce: result2.nonce,
        mimeType: 'application/pdf'
      }
    ];

    // Simulate the E2EEPlaintext payload
    const payload = JSON.stringify({
      content: '<p>Check out these files</p>',
      fileKeys
    });

    // Simulate receiving and parsing the payload
    const parsed = JSON.parse(payload);

    expect(parsed.content).toBe('<p>Check out these files</p>');
    expect(parsed.fileKeys).toHaveLength(2);
    expect(parsed.fileKeys[0].mimeType).toBe('image/jpeg');
    expect(parsed.fileKeys[1].mimeType).toBe('application/pdf');

    // Verify keys can actually decrypt the corresponding files
    const decrypted1 = await decryptFile(
      await result1.encryptedBlob.arrayBuffer(),
      parsed.fileKeys[0].key,
      parsed.fileKeys[0].nonce,
      parsed.fileKeys[0].mimeType
    );
    expect(await decrypted1.text()).toBe('image data');
    expect(decrypted1.type).toBe('image/jpeg');

    const decrypted2 = await decryptFile(
      await result2.encryptedBlob.arrayBuffer(),
      parsed.fileKeys[1].key,
      parsed.fileKeys[1].nonce,
      parsed.fileKeys[1].mimeType
    );
    expect(await decrypted2.text()).toBe('document');
    expect(decrypted2.type).toBe('application/pdf');
  });

  test('file keys survive JSON serialization (simulates E2EE transport)', async () => {
    const file = new File(['secret'], 'secret.txt', { type: 'text/plain' });
    const { encryptedBlob, key, nonce } = await encryptFile(file);

    // Simulate the full transport: encrypt -> JSON -> transmit -> JSON parse -> decrypt
    const fileKey = { fileId: 'f1', key, nonce, mimeType: 'text/plain' };
    const serialized = JSON.stringify(fileKey);
    const deserialized = JSON.parse(serialized);

    const decrypted = await decryptFile(
      await encryptedBlob.arrayBuffer(),
      deserialized.key,
      deserialized.nonce,
      deserialized.mimeType
    );

    expect(await decrypted.text()).toBe('secret');
  });

  test('index-based key matching works correctly', async () => {
    // Simulate 3 files uploaded and encrypted
    const files = [
      new File(['img'], 'a.png', { type: 'image/png' }),
      new File(['vid'], 'b.mp4', { type: 'video/mp4' }),
      new File(['doc'], 'c.txt', { type: 'text/plain' })
    ];

    const encrypted = await Promise.all(files.map((f) => encryptFile(f)));

    const store = createFileKeyStore();
    const messageId = 100;

    // Build fileKeys in same order as files array
    const fileKeys: FileKeyEntry[] = encrypted.map((e, i) => ({
      fileId: `file-${i}`,
      key: e.key,
      nonce: e.nonce,
      mimeType: files[i]!.type
    }));

    store.set(messageId, fileKeys);

    // Simulate the renderer: for each file, get key by index
    const keys = store.get(messageId)!;

    for (let i = 0; i < files.length; i++) {
      const keyInfo = keys[i]!;
      const decrypted = await decryptFile(
        await encrypted[i]!.encryptedBlob.arrayBuffer(),
        keyInfo.key,
        keyInfo.nonce,
        keyInfo.mimeType
      );
      const text = await decrypted.text();
      const originalText = await files[i]!.text();
      expect(text).toBe(originalText);
    }
  });
});
