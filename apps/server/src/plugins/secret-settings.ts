import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { getFileHmacSecretSync } from '../db/queries/server';

/**
 * A `secret` plugin setting at rest. The loader keeps every setting in
 * plugin_data.settings as JSON; a secret one is stored there as a
 * sealed envelope `{ sealed: "<ciphertext>" }` instead of its text —
 * AES-256-GCM under a key derived from the instance's file-signing
 * secret, the construction the community import uses for its bot
 * token, with its own key label so a plugin ciphertext never decrypts
 * as an import token or the other way round. The envelope is an object
 * on purpose: a plain string in that column is a value written before
 * the setting became a secret, and the loader seals it on first load.
 *
 * The plaintext exists in two places only: the loader's in-memory map
 * (what the plugin's `settings.get` returns) and the update route's
 * request. It is never logged and never returned by any route.
 */

const VERSION = 'v1';
/** The same bound the settings route puts on any string value. */
const MAX_SECRET_LENGTH = 4096;

type TSealedSetting = { sealed: string };

const deriveKey = (): Buffer =>
  createHash('sha256')
    .update(`pulse-plugin-secret:${getFileHmacSecretSync()}`)
    .digest();

const isSealedSetting = (value: unknown): value is TSealedSetting =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { sealed?: unknown }).sealed === 'string';

const sealPluginSecret = (plaintext: string): TSealedSetting => {
  if (plaintext.length === 0 || plaintext.length > MAX_SECRET_LENGTH) {
    throw new Error('Secret length out of bounds');
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    sealed: [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url')
    ].join('.')
  };
};

/** Throws on a damaged envelope or one sealed by another instance. */
const unsealPluginSecret = (envelope: TSealedSetting): string => {
  const [version, iv, tag, body] = envelope.sealed.split('.');

  if (version !== VERSION || !iv || !tag || !body) {
    throw new Error('Unreadable secret ciphertext');
  }

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final()
  ]).toString('utf8');
};

export { isSealedSetting, MAX_SECRET_LENGTH, sealPluginSecret, unsealPluginSecret };
export type { TSealedSetting };
