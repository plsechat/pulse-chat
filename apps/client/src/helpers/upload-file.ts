import { store } from '@/features/store';
import { encryptFile } from '@/lib/e2ee/file-crypto';
import { getAccessToken } from '@/lib/supabase';
import { UploadHeaders, type TTempFile } from '@pulse/shared';
import { toast } from 'sonner';
import { getUrlFromServer } from './get-file-url';

export type TEncryptedUploadResult = {
  tempFile: TTempFile;
  key: string;
  nonce: string;
  mimeType: string;
  /** Real (plaintext) filename — must be packed into the E2EE message
   *  envelope's fileKeys so the recipient can render it. The server only
   *  ever sees a placeholder UUID. */
  originalName: string;
  /** Real extension (with leading dot, e.g. `.png`). */
  extension: string;
};

/**
 * Resolve the upload endpoint and auth headers for the active server
 * (home vs federated). Both `uploadFile` and `uploadEncryptedFile`
 * shared the exact same 30-line "if active federated → federation
 * token, else → access token" branch — drift-prone, since each path
 * also chose its own MIME type and content-length, easy to update
 * one and forget the other.
 */
const buildUploadRequest = async (params: {
  type: string;
  contentLength: number;
  originalName: string;
  encrypted?: boolean;
}): Promise<{ url: string; headers: Record<string, string> } | null> => {
  const state = store.getState();
  const activeInstanceDomain = state.app.activeInstanceDomain;

  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    [UploadHeaders.TYPE]: params.type,
    [UploadHeaders.CONTENT_LENGTH]: params.contentLength.toString(),
    [UploadHeaders.ORIGINAL_NAME]: params.originalName
  };
  if (params.encrypted) {
    headers[UploadHeaders.ENCRYPTED] = 'true';
  }

  if (activeInstanceDomain) {
    // On a federated server — upload to the remote instance.
    const entry = state.app.federatedServers.find(
      (s) => s.instanceDomain === activeInstanceDomain
    );
    if (!entry) {
      toast.error('Federated server connection not found');
      return null;
    }
    headers[UploadHeaders.TOKEN] = '';
    headers['x-federation-token'] = entry.federationToken;
    return { url: entry.remoteUrl, headers };
  }

  // Local server — upload to home.
  headers[UploadHeaders.TOKEN] = (await getAccessToken()) ?? '';
  return { url: getUrlFromServer(), headers };
};

const uploadFile = async (file: File) => {
  const req = await buildUploadRequest({
    type: file.type,
    contentLength: file.size,
    originalName: file.name
  });
  if (!req) return undefined;

  const res = await fetch(`${req.url}/upload`, {
    method: 'POST',
    headers: req.headers,
    body: file
  });

  if (!res.ok) {
    const errorData = await res.json();
    toast.error(errorData.error || res.statusText);
    return undefined;
  }

  const tempFile: TTempFile = await res.json();
  return tempFile;
};

const uploadFiles = async (files: File[]) => {
  const uploadedFiles: TTempFile[] = [];
  for (const file of files) {
    const uploadedFile = await uploadFile(file);
    if (!uploadedFile) continue;
    uploadedFiles.push(uploadedFile);
  }
  return uploadedFiles;
};

/**
 * Generate a placeholder filename for an encrypted upload. The real
 * name lives encrypted in the message envelope; the server-stored row
 * only sees the placeholder. Random hex keeps disk filenames unique
 * without burning a UUID dependency on the client.
 */
const placeholderEncryptedName = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}.bin`;
};

const uploadEncryptedFile = async (
  file: File
): Promise<TEncryptedUploadResult | undefined> => {
  const { encryptedBlob, key, nonce } = await encryptFile(file);
  const mimeType = file.type;
  const originalName = file.name;
  // Derive extension from the real name (with leading dot to match
  // server's path.extname output). Empty string for files with no
  // extension — render layer handles that.
  const lastDot = originalName.lastIndexOf('.');
  const extension = lastDot >= 0 ? originalName.slice(lastDot) : '';
  const placeholderName = placeholderEncryptedName();

  // Create a File-like object from the encrypted blob with a redacted
  // name so the upload path doesn't leak the real filename through
  // any framing or logs.
  const encryptedFile = new File([encryptedBlob], placeholderName, {
    type: 'application/octet-stream'
  });

  const req = await buildUploadRequest({
    type: 'application/octet-stream',
    contentLength: encryptedFile.size,
    originalName: placeholderName,
    encrypted: true
  });
  if (!req) return undefined;

  const res = await fetch(`${req.url}/upload`, {
    method: 'POST',
    headers: req.headers,
    body: encryptedFile
  });

  if (!res.ok) {
    const errorData = await res.json();
    toast.error(errorData.error || res.statusText);
    return undefined;
  }

  const tempFile: TTempFile = await res.json();
  return { tempFile, key, nonce, mimeType, originalName, extension };
};

const uploadEncryptedFiles = async (files: File[]) => {
  const results: TEncryptedUploadResult[] = [];
  for (const file of files) {
    const result = await uploadEncryptedFile(file);
    if (!result) continue;
    results.push(result);
  }
  return results;
};

export { uploadFile, uploadFiles, uploadEncryptedFile, uploadEncryptedFiles };
