import type { TFile } from '@pulse/shared';
import { getFileKeys } from '@/lib/e2ee/file-key-store';
import { decryptFile } from '@/lib/e2ee/file-crypto';
import { getFileUrl } from './get-file-url';

const downloadFile = async (file: TFile) => {
  const fileUrl = getFileUrl(file);

  if (!fileUrl) {
    console.error('Failed to get file URL.');
    return;
  }

  const response = await fetch(fileUrl);

  if (!response.ok) {
    console.error(`Failed to download file: ${response.statusText}`);
    return;
  }

  const link = document.createElement('a');

  link.href = URL.createObjectURL(await response.blob());
  link.download = file.originalName;

  link.click();
};

/**
 * Download an encrypted file attachment — fetches the encrypted blob,
 * decrypts it client-side, then triggers the browser download.
 */
const downloadEncryptedFile = async (
  file: TFile,
  messageId: number,
  fileIndex: number,
  instanceDomain?: string
) => {
  const fileUrl = getFileUrl(file, instanceDomain);
  if (!fileUrl) {
    console.error('Failed to get file URL.');
    return;
  }

  const keys = getFileKeys(messageId);
  const keyInfo = keys?.[fileIndex];

  const response = await fetch(fileUrl);
  if (!response.ok) {
    console.error(`Failed to download file: ${response.statusText}`);
    return;
  }

  let blob: Blob;
  if (keyInfo) {
    const encryptedData = await response.arrayBuffer();
    blob = await decryptFile(encryptedData, keyInfo.key, keyInfo.nonce, keyInfo.mimeType);
  } else {
    blob = await response.blob();
  }

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = file.originalName;
  link.click();
};

export { downloadFile, downloadEncryptedFile };
