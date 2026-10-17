import type { PluginContext, TPluginFileRef } from '@pulse/plugin-sdk';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { getInstanceServerSettings } from '../../db/queries/server';
import { BLOCKED_EXTENSIONS } from '../../http/upload';
import { federationFetch } from '../../utils/federation-fetch';
import { fileManager } from '../../utils/file-manager';
import { getPluginActorUserId } from '../actor';
import { parseActionInput, PluginActionError } from '../errors';

/**
 * `ctx.actions.files.upload` — store a file under the plugin's actor.
 *
 * Same gates as the HTTP upload route, in the same order: uploads
 * enabled, size under the instance cap, extension not in the blocked
 * list, quota room for the actor; then the standard temp-file → saveFile
 * path so storage overflow handling and the public-name scheme apply.
 * A URL is fetched through the hardened client (SSRF validation, DNS
 * pinning, no redirects, body capped at the upload limit) — never a raw
 * fetch of a plugin-supplied address.
 *
 * The stored file counts as an orphan until a message references it;
 * the cleanup cron removes orphans older than its grace window, so a
 * plugin uploads and attaches in one go.
 */

const MAX_FILENAME_LENGTH = 255;
const MAX_URL_LENGTH = 2048;
const MAX_MIME_LENGTH = 255;
/** Upper bound on a remote fetch; a stalled upstream must not pin the loop. */
const URL_FETCH_TIMEOUT_MS = 30_000;

/** Extension to adopt when the filename carries none and the mime is known. */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'application/pdf': '.pdf',
  'text/plain': '.txt'
};

const uploadSchema = z
  .object({
    bytes: z
      .union([z.instanceof(Uint8Array), z.instanceof(ArrayBuffer)])
      .optional(),
    url: z
      .string()
      .max(MAX_URL_LENGTH)
      .regex(/^https?:\/\//i, 'url must be http(s)')
      .optional(),
    filename: z.string().trim().min(1).max(MAX_FILENAME_LENGTH),
    mime: z
      .string()
      .max(MAX_MIME_LENGTH)
      .regex(/^[\w.+-]+\/[\w.+-]+$/, 'mime must look like type/subtype')
      .optional(),
    serverId: z.number().int().positive().optional()
  })
  .refine((v) => (v.bytes !== undefined) !== (v.url !== undefined), {
    message: 'Provide exactly one of bytes or url'
  });

/** Strip directories and control characters; the stored name is a UUID anyway. */
const sanitizeFilename = (filename: string, mime: string | undefined) => {
  const base = Array.from(path.basename(filename))
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join('');
  const hasExtension = /\.[a-z0-9]{1,16}$/i.test(base);

  if (hasExtension || !mime) return base;

  const ext = EXTENSION_BY_MIME[mime.toLowerCase()];

  return ext ? `${base}${ext}` : base;
};

const fetchRemoteBytes = async (
  url: string,
  maxBytes: number
): Promise<Uint8Array> => {
  let response: Awaited<ReturnType<typeof federationFetch>>;

  try {
    response = await federationFetch(url, {
      maxBytes,
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    throw new PluginActionError(
      'BAD_REQUEST',
      `Could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    throw new PluginActionError(
      'BAD_REQUEST',
      `Could not fetch ${url}: upstream answered ${response.status}`
    );
  }

  // Honour a truthful Content-Length before reading; a lying one is
  // caught by the streaming cap in readBodyWithCap.
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);

  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PluginActionError(
      'BAD_REQUEST',
      'The file exceeds the maximum allowed size'
    );
  }

  try {
    return await response.bytes();
  } catch {
    throw new PluginActionError(
      'BAD_REQUEST',
      'The file exceeds the maximum allowed size'
    );
  }
};

const createFileActions = (): PluginContext['actions']['files'] => {
  const upload: PluginContext['actions']['files']['upload'] = async (
    rawInput
  ) => {
    const input = parseActionInput(uploadSchema, rawInput);
    const settings = await getInstanceServerSettings();

    if (!settings.storageUploadEnabled) {
      throw new PluginActionError(
        'FORBIDDEN',
        'File uploads are disabled on this server'
      );
    }

    const filename = sanitizeFilename(input.filename, input.mime);
    const ext = path.extname(filename).toLowerCase();

    if (BLOCKED_EXTENSIONS.has(ext)) {
      throw new PluginActionError('BAD_REQUEST', `File type ${ext} is not allowed`);
    }

    const maxBytes = settings.storageUploadMaxFileSize;
    const bytes =
      input.url !== undefined
        ? await fetchRemoteBytes(input.url, maxBytes)
        : input.bytes instanceof ArrayBuffer
          ? new Uint8Array(input.bytes)
          : input.bytes!;

    if (bytes.byteLength === 0) {
      throw new PluginActionError('BAD_REQUEST', 'Empty files cannot be uploaded');
    }

    if (bytes.byteLength > maxBytes) {
      throw new PluginActionError(
        'BAD_REQUEST',
        'The file exceeds the maximum allowed size'
      );
    }

    const actorUserId = await getPluginActorUserId();
    const quota = await fileManager.getStorageViolation(actorUserId, bytes.byteLength);

    if (quota === 'user') {
      throw new PluginActionError('FORBIDDEN', 'User storage limit exceeded');
    }

    if (quota === 'server') {
      throw new PluginActionError('FORBIDDEN', 'Server storage limit exceeded');
    }

    const uploadPath = await fileManager.getSafeUploadPath(filename);
    await fs.writeFile(uploadPath, bytes);

    const temp = await fileManager.addTemporaryFile({
      originalName: filename,
      filePath: uploadPath,
      size: bytes.byteLength,
      userId: actorUserId
    });

    let stored;

    try {
      stored = await fileManager.saveFile(temp.id, actorUserId);
    } catch (error) {
      await fileManager.removeTemporaryFile(temp.id).catch(() => {});

      throw new PluginActionError(
        'FORBIDDEN',
        error instanceof Error ? error.message : 'File could not be stored'
      );
    }

    const ref: TPluginFileRef = {
      id: stored.id,
      name: stored.name,
      originalName: stored.originalName,
      url: `/public/${stored.name}`,
      size: stored.size,
      mimeType: stored.mimeType
    };

    return ref;
  };

  return { upload };
};

export { createFileActions };
