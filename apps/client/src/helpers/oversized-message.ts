import type { TTempFile } from '@pulse/shared';
import {
  uploadEncryptedFiles,
  uploadFiles,
  type TEncryptedUploadResult
} from './upload-file';

export type TOversizedUpload = {
  tempFile: TTempFile;
  /** Present only for E2EE uploads — feeds the message envelope's fileKeys. */
  keyInfo?: TEncryptedUploadResult;
};

export const OVERSIZED_MESSAGE_FILENAME = 'message.txt';

/** Detects a code block in either the composer HTML or the token content. */
export const messageHasCodeBlock = (html: string, tokenContent: string) =>
  /<pre/i.test(html) || tokenContent.includes('```');

/**
 * Ship an over-length message as a .txt attachment instead of rejecting
 * it. Uploads the full token content as message.txt (client-encrypted for
 * E2EE targets) and returns the temp file to thread into the send
 * mutation. Returns null when the upload failed — callers must abort the
 * send (upload helpers toast HTTP errors themselves).
 */
export const uploadOversizedMessage = async (
  content: string,
  e2ee: boolean
): Promise<TOversizedUpload | null> => {
  const file = new File([content], OVERSIZED_MESSAGE_FILENAME, {
    type: 'text/plain'
  });

  if (e2ee) {
    const [result] = await uploadEncryptedFiles([file]);
    if (!result) return null;
    return { tempFile: result.tempFile, keyInfo: result };
  }

  const [tempFile] = await uploadFiles([file]);
  if (!tempFile) return null;
  return { tempFile };
};
