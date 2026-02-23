import { getAccessToken } from '@/lib/supabase';
import { store } from '@/features/store';
import { encryptFile } from '@/lib/e2ee/file-crypto';
import { UploadHeaders, type TTempFile } from '@pulse/shared';
import { toast } from 'sonner';
import { getUrlFromServer } from './get-file-url';

export type TEncryptedUploadResult = {
  tempFile: TTempFile;
  key: string;
  nonce: string;
  mimeType: string;
};

const uploadFile = async (file: File) => {
  const state = store.getState();
  const activeInstanceDomain = state.app.activeInstanceDomain;

  let url: string;
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    [UploadHeaders.TYPE]: file.type,
    [UploadHeaders.CONTENT_LENGTH]: file.size.toString(),
    [UploadHeaders.ORIGINAL_NAME]: file.name
  };

  if (activeInstanceDomain) {
    // On a federated server — upload to the remote instance
    const entry = state.app.federatedServers.find(
      (s) => s.instanceDomain === activeInstanceDomain
    );

    if (!entry) {
      toast.error('Federated server connection not found');
      return undefined;
    }

    url = entry.remoteUrl;
    headers[UploadHeaders.TOKEN] = '';
    headers['x-federation-token'] = entry.federationToken;
  } else {
    // Local server — upload to home
    url = getUrlFromServer();
    headers[UploadHeaders.TOKEN] = (await getAccessToken()) ?? '';
  }

  const res = await fetch(`${url}/upload`, {
    method: 'POST',
    headers,
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

  const state = store.getState();
  const activeInstanceDomain = state.app.activeInstanceDomain;

  let url: string;
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    [UploadHeaders.TYPE]: 'application/octet-stream',
    [UploadHeaders.CONTENT_LENGTH]: encryptedFile.size.toString(),
    [UploadHeaders.ORIGINAL_NAME]: file.name
  };

  if (activeInstanceDomain) {
    const entry = state.app.federatedServers.find(
      (s) => s.instanceDomain === activeInstanceDomain
    );

    if (!entry) {
      toast.error('Federated server connection not found');
      return undefined;
    }

    url = entry.remoteUrl;
    headers[UploadHeaders.TOKEN] = '';
    headers['x-federation-token'] = entry.federationToken;
  } else {
    url = getUrlFromServer();
    headers[UploadHeaders.TOKEN] = (await getAccessToken()) ?? '';
  }

  const res = await fetch(`${url}/upload`, {
    method: 'POST',
    headers,
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
