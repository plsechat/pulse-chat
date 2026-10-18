import {
  getDecryptedFileUrl,
  getFileKeys,
  rememberDecryptedFileUrl
} from '@/lib/e2ee/file-key-store';
import { decryptFile } from '@/lib/e2ee/file-crypto';
import { getFileUrl } from '@/helpers/get-file-url';
import type { TFile } from '@pulse/server/types';
import { useEffect, useState } from 'react';

/**
 * Hook that returns a usable URL for a file attachment.
 * For encrypted files (E2EE messages with file keys), it fetches the
 * encrypted blob, decrypts it client-side, and returns a blob URL.
 * For non-encrypted files, returns the direct server URL.
 *
 * Decrypted URLs live in the bounded cache in file-key-store.ts, which
 * revokes them on eviction and on logout — an unbounded module map
 * here kept every decrypted Blob of the session alive.
 */
export function useDecryptedFileUrl(
  file: TFile,
  messageId: number,
  isE2ee: boolean,
  fileIndex: number,
  instanceDomain?: string
): { url: string; loading: boolean } {
  const directUrl = getFileUrl(file, instanceDomain);
  const fileKeys = isE2ee ? getFileKeys(messageId) : undefined;
  const keyInfo = fileKeys?.[fileIndex];

  const [url, setUrl] = useState<string>(() => {
    if (!keyInfo) return directUrl;
    return getDecryptedFileUrl(messageId, file.id) ?? '';
  });
  const [loading, setLoading] = useState<boolean>(() => {
    if (!keyInfo) return false;
    return getDecryptedFileUrl(messageId, file.id) === undefined;
  });

  useEffect(() => {
    if (!keyInfo) {
      setUrl(directUrl);
      setLoading(false);
      return;
    }

    const cached = getDecryptedFileUrl(messageId, file.id);
    if (cached) {
      setUrl(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const response = await fetch(directUrl);
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
        const encryptedData = await response.arrayBuffer();
        const decryptedBlob = await decryptFile(
          encryptedData,
          keyInfo.key,
          keyInfo.nonce,
          keyInfo.mimeType
        );
        const blobUrl = URL.createObjectURL(decryptedBlob);
        // Cached even when this mount was cancelled mid-flight: the
        // decrypt work is done and the next mount of the same
        // attachment should not repeat it.
        rememberDecryptedFileUrl(messageId, file.id, blobUrl);

        if (!cancelled) {
          setUrl(blobUrl);
          setLoading(false);
        }
      } catch (err) {
        console.error('[E2EE] Failed to decrypt file:', err);
        if (!cancelled) {
          setUrl(directUrl);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [directUrl, keyInfo, messageId, file.id]);

  return { url, loading };
}
