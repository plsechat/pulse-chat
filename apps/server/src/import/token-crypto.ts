import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { getFileHmacSecretSync } from '../db/queries/server';

/**
 * The bot token at rest. It is the one secret an import holds, it has
 * to survive a restart (the job resumes), and nobody — not the owner
 * who pasted it, not an instance admin reading the table — should get
 * it back out: AES-256-GCM under a key derived from the instance's
 * file-signing secret, never logged, erased from the row when the job
 * ends. A ciphertext from another instance (different secret) fails
 * to authenticate rather than decrypting to garbage.
 */

const VERSION = 'v1';
const TOKEN_MAX_LENGTH = 128;

const deriveKey = (): Buffer =>
  createHash('sha256')
    .update(`pulse-import-token:${getFileHmacSecretSync()}`)
    .digest();

const encryptImportToken = (token: string): string => {
  if (token.length === 0 || token.length > TOKEN_MAX_LENGTH) {
    throw new Error('Token length out of bounds');
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url')
  ].join('.');
};

const decryptImportToken = (ciphertext: string): string => {
  const [version, iv, tag, body] = ciphertext.split('.');

  if (version !== VERSION || !iv || !tag || !body) {
    throw new Error('Unreadable token ciphertext');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(),
    Buffer.from(iv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final()
  ]).toString('utf8');
};

export { decryptImportToken, encryptImportToken, TOKEN_MAX_LENGTH };
