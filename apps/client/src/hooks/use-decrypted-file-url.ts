import { getFileKeys } from '@/lib/e2ee/file-key-store';
import { decryptFile } from '@/lib/e2ee/file-crypto';
import { getFileUrl } from '@/helpers/get-file-url';
import type { TFile } from '@pulse/shared';
import { useEffect, useRef, useState } from 'react';

// Module-level cache to avoid re-fetching/re-decrypting the same file
const blobUrlCache = new Map<string, string>();

function getCacheKey(messageId: number, fileId: number): string {
  return `${messageId}:${fileId}`;
}

/**
 * Hook that returns a usable URL for a file attachment.
 * For encrypted files (E2EE messages with file keys), it fetches the
 * encrypted blob, decrypts it client-side, and returns a blob URL.
 * For non-encrypted files, returns the direct server URL.
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
    const cached = blobUrlCache.get(getCacheKey(messageId, file.id));
    return cached ?? '';
  });
  const [loading, setLoading] = useState<boolean>(() => {
    if (!keyInfo) return false;
    return !blobUrlCache.has(getCacheKey(messageId, file.id));
  });
  const revokableRef = useRef<string | null>(null);

  useEffect(() => {
    if (!keyInfo) {
      setUrl(directUrl);
      setLoading(false);
      return;
    }

    const cacheKey = getCacheKey(messageId, file.id);
    const cached = blobUrlCache.get(cacheKey);
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
        blobUrlCache.set(cacheKey, blobUrl);

        if (!cancelled) {
          revokableRef.current = blobUrl;
          setUrl(blobUrl);
          setLoading(false);
        } else {
          // If cancelled, still keep in cache for future use
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
