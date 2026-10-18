import { eq } from 'drizzle-orm';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { db } from '../db';
import { channels } from '../db/schema';
import { dmFileSalt, verifyFileToken } from '../helpers/files-crypto';
import { PUBLIC_PATH } from '../helpers/paths';
import { logger } from '../logger';
import {
  getFileAssociation,
  invalidateFileAssociation
} from '../utils/file-association-cache';

/**
 * Served on EVERY /public response, overriding the app-wide policy set
 * in http/index.ts. Uploads are user-controlled bytes on the app
 * origin: without this, a stored document rendered inline (any type the
 * denylist in upload.ts missed, or a stale pre-denylist upload) could run
 * script with access to the SPA's localStorage tokens. `sandbox` gives
 * the document an opaque origin and no script; `default-src 'none'`
 * covers anything the sandbox flag alone would not.
 */
const PUBLIC_FILE_CSP = "default-src 'none'; sandbox";

/**
 * Stored names are random, immutable UUIDs: the bytes behind a name
 * never change, so a public file (avatar, emoji, attachment in a public
 * channel) can be cached for as long as the browser likes. A tokenised
 * file is still keyed by its full URL, but it is tied to one viewer's
 * token, so the cache is marked private and capped at the minimum
 * token validity — a cached copy never outlives the token that fetched
 * it by more than the rotation window described in files-crypto.ts.
 */
const CACHE_CONTROL_PUBLIC = 'public, max-age=31536000, immutable';
const CACHE_CONTROL_PRIVATE = 'private, max-age=43200';

/**
 * Only types a browser can render without a script engine are served
 * inline; everything else is an application/octet-stream download so the
 * stored Content-Type is never a vector. SVG is image/* but can carry
 * script, so it is excluded.
 */
const isInlineSafe = (mimeType: string): boolean => {
  const type = mimeType.split(';')[0]!.trim().toLowerCase();

  if (type === 'image/svg+xml') return false;

  return (
    type.startsWith('image/') ||
    type.startsWith('video/') ||
    type.startsWith('audio/') ||
    type === 'application/pdf'
  );
};

/**
 * RFC 6266 Content-Disposition. Node refuses header values outside
 * latin1, so a non-ASCII original name gets an ASCII fallback plus the
 * RFC 5987 `filename*` form that browsers prefer.
 */
const contentDisposition = (type: 'inline' | 'attachment', name: string) => {
  const clean = name.replace(/[\r\n"\\]/g, '');
  const asciiOnly = /^[\x20-\x7e]*$/.test(clean);

  if (asciiOnly) {
    return `${type}; filename="${clean}"`;
  }

  const fallback = clean.replace(/[^\x20-\x7e]/g, '_');

  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
};

/**
 * A single `bytes=a-b` / `bytes=a-` / `bytes=-n` range (RFC 9110 §14).
 * Anything else — several ranges, other units, garbage — is ignored and
 * the whole file goes out as a plain 200, which is what the RFC allows
 * and what every player copes with. `unsatisfiable` is the one case
 * that must NOT fall back to 200: a seek past the end gets a 416 so the
 * player knows the size instead of restarting from byte 0.
 */
type TRange =
  | { kind: 'none' }
  | { kind: 'unsatisfiable' }
  | { kind: 'slice'; start: number; end: number };

const parseRange = (header: string | undefined, size: number): TRange => {
  if (!header) return { kind: 'none' };

  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());

  if (!match) return { kind: 'none' };

  const [, startPart, endPart] = match;

  if (startPart === '' && endPart === '') return { kind: 'none' };

  if (startPart === '') {
    // Suffix form: the last n bytes. n = 0 is unsatisfiable by spec;
    // n beyond the size is simply the whole file.
    const suffix = Number(endPart);

    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };

    return { kind: 'slice', start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(startPart);

  if (start >= size) return { kind: 'unsatisfiable' };

  const end = endPart === '' ? size - 1 : Math.min(Number(endPart), size - 1);

  if (end < start) return { kind: 'unsatisfiable' };

  return { kind: 'slice', start, end };
};

const sendJson = (
  res: http.ServerResponse,
  status: number,
  body: Record<string, string>
) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const publicRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  // On every variant, including the error and 304/416 ones: the CSP and
  // nosniff because the body is user-controlled, Accept-Ranges so a
  // player knows seeking is supported before it asks.
  res.setHeader('Content-Security-Policy', PUBLIC_FILE_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');

  if (!req.url) {
    sendJson(res, 400, { error: 'Bad request' });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  let fileName: string;

  try {
    fileName = decodeURIComponent(path.basename(url.pathname));
  } catch {
    // Malformed percent-encoding is a client error, not a 500.
    sendJson(res, 400, { error: 'Bad request' });
    return;
  }

  const association = await getFileAssociation(fileName);

  if (!association) {
    sendJson(res, 404, { error: 'File not found' });
    return;
  }

  const { dbFile } = association;
  let cacheControl = CACHE_CONTROL_PUBLIC;

  if (association.kind === 'channel') {
    // Read fresh on every request — never memoised — so a rotated salt
    // or a flip to private is enforced on the very next fetch.
    const [channel] = await db
      .select({
        private: channels.private,
        fileAccessToken: channels.fileAccessToken
      })
      .from(channels)
      .where(eq(channels.id, association.channelId))
      .limit(1);

    if (!channel) {
      // The channel (and with it the message link) is gone; the cron
      // will collect the file. Drop the stale entry rather than serve
      // it for the rest of its minute.
      invalidateFileAssociation(fileName);
      sendJson(res, 404, { error: 'File not found' });
      return;
    }

    if (channel.private) {
      const accessToken = url.searchParams.get('accessToken') ?? '';

      if (!verifyFileToken(dbFile.id, channel.fileAccessToken, accessToken)) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }

      cacheControl = CACHE_CONTROL_PRIVATE;
    }
  } else if (association.kind === 'dm') {
    // DMs are private by definition: always gated behind the DM token.
    const accessToken = url.searchParams.get('accessToken') ?? '';

    if (
      !verifyFileToken(
        dbFile.id,
        dmFileSalt(association.dmChannelId),
        accessToken
      )
    ) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }

    cacheControl = CACHE_CONTROL_PRIVATE;
  }

  const filePath = path.join(PUBLIC_PATH, dbFile.name);
  let size: number;

  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch {
    sendJson(res, 404, { error: 'File not found on disk' });
    return;
  }

  const inline = isInlineSafe(dbFile.mimeType);
  // The stored name is immutable and unique, so it IS the entity tag.
  const etag = `"${dbFile.name}"`;

  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('ETag', etag);
  res.setHeader(
    'Content-Disposition',
    contentDisposition(inline ? 'inline' : 'attachment', dbFile.originalName)
  );

  // Conditional revalidation after a cached copy's max-age ran out: the
  // bytes never change, so a matching tag is always still fresh. Checked
  // only after the access check so a revoked token learns nothing.
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  const contentType = inline ? dbFile.mimeType : 'application/octet-stream';

  // If-Range with a tag we don't recognise means the client's partial
  // copy came from something else; send the whole file as asked.
  const ifRange = req.headers['if-range'];
  const range =
    ifRange !== undefined && ifRange !== etag
      ? { kind: 'none' as const }
      : parseRange(req.headers.range, size);

  if (range.kind === 'unsatisfiable') {
    res.writeHead(416, {
      'Content-Type': 'application/json',
      'Content-Range': `bytes */${size}`
    });
    res.end(JSON.stringify({ error: 'Range not satisfiable' }));
    return;
  }

  const fileStream =
    range.kind === 'slice'
      ? fs.createReadStream(filePath, { start: range.start, end: range.end })
      : fs.createReadStream(filePath);

  if (range.kind === 'slice') {
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`
    });
  } else {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': size
    });
  }

  fileStream.pipe(res);

  fileStream.on('error', (err) => {
    logger.error('Error serving file:', err);

    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' });
    } else {
      res.destroy();
    }
  });

  res.on('close', () => {
    fileStream.destroy();
  });

  fileStream.on('end', () => {
    res.end();
  });

  return res;
};

export { publicRouteHandler };
