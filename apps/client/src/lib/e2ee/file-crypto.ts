import { arrayBufferToBase64, base64ToArrayBuffer } from './utils';

/**
 * Encrypt a file using AES-256-GCM via WebCrypto API.
 * Returns the encrypted blob and the key/nonce needed to decrypt it.
 */
export async function encryptFile(
  file: File
): Promise<{
  encryptedBlob: Blob;
  key: string;
  nonce: string;
}> {
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
    encryptedBlob: new Blob([encrypted], {
      type: 'application/octet-stream'
    }),
    key: arrayBufferToBase64(exportedKey),
    nonce: arrayBufferToBase64(nonce.buffer)
  };
}

/**
 * Decrypt a file using AES-256-GCM.
 */
export async function decryptFile(
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
