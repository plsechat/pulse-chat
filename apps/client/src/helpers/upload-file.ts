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
}): Promise<{ url: string; headers: Record<string, string> } | null> => {
  const state = store.getState();
  const activeInstanceDomain = state.app.activeInstanceDomain;

  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    [UploadHeaders.TYPE]: params.type,
    [UploadHeaders.CONTENT_LENGTH]: params.contentLength.toString(),
    [UploadHeaders.ORIGINAL_NAME]: params.originalName
  };

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

const uploadEncryptedFile = async (
  file: File
): Promise<TEncryptedUploadResult | undefined> => {
  const { encryptedBlob, key, nonce } = await encryptFile(file);
  const mimeType = file.type;

  // Create a File-like object from the encrypted blob so the upload
  // path can use it identically, but with the original name preserved.
  const encryptedFile = new File([encryptedBlob], file.name, {
    type: 'application/octet-stream'
  });

  const req = await buildUploadRequest({
    type: 'application/octet-stream',
    contentLength: encryptedFile.size,
    originalName: file.name
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
  return { tempFile, key, nonce, mimeType };
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
