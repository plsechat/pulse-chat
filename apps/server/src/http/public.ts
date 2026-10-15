import { eq } from 'drizzle-orm';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { db } from '../db';
import { getDmChannelIdByFileId } from '../db/queries/dms';
import { isFileOrphaned } from '../db/queries/files';
import { getMessageByFileId } from '../db/queries/messages';
import { channels, files } from '../db/schema';
import { dmFileSalt, verifyFileToken } from '../helpers/files-crypto';
import { PUBLIC_PATH } from '../helpers/paths';
import { logger } from '../logger';

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

const publicRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  res.setHeader('Content-Security-Policy', PUBLIC_FILE_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  let fileName: string;

  try {
    fileName = decodeURIComponent(path.basename(url.pathname));
  } catch {
    // Malformed percent-encoding is a client error, not a 500.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return;
  }

  const [dbFile] = await db
    .select()
    .from(files)
    .where(eq(files.name, fileName))
    .limit(1);

  if (!dbFile) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
    return;
  }

  const isOrphaned = await isFileOrphaned(dbFile.id);

  if (isOrphaned) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
    return;
  }

  // A file is one of: a server-channel message attachment, a DM message
  // attachment, or profile/emoji media (avatar/banner/logo/emoji). The
  // orphaned check above already rejected files referenced by nothing.
  const associatedMessage = await getMessageByFileId(dbFile.id);

  if (associatedMessage) {
    // Server-channel attachment: gate PRIVATE channels behind the
    // per-channel file token.
    const [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, associatedMessage.channelId))
      .limit(1);

    if (channel && channel.private) {
      const accessToken = url.searchParams.get('accessToken');
      const isValidToken = verifyFileToken(
        dbFile.id,
        channel.fileAccessToken,
        accessToken || ''
      );

      if (!isValidToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
    }
  } else {
    // DM attachment: always gated. DMs are private by definition, and
    // these previously fell through to the fully-public branch below
    // (getMessageByFileId only covers server messages), so DM files were
    // served with no check at all. Require the DM file token.
    const dmChannelId = await getDmChannelIdByFileId(dbFile.id);
    if (dmChannelId !== undefined) {
      const accessToken = url.searchParams.get('accessToken');
      const isValidToken = verifyFileToken(
        dbFile.id,
        dmFileSalt(dmChannelId),
        accessToken || ''
      );

      if (!isValidToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
    }
  }

  const filePath = path.join(PUBLIC_PATH, dbFile.name);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found on disk' }));
    return;
  }

  const fileStream = fs.createReadStream(filePath);

  const inline = isInlineSafe(dbFile.mimeType);

  res.writeHead(200, {
    'Content-Type': inline ? dbFile.mimeType : 'application/octet-stream',
    'Content-Length': dbFile.size,
    'Content-Disposition': contentDisposition(
      inline ? 'inline' : 'attachment',
      dbFile.originalName
    )
  });

  fileStream.pipe(res);

  fileStream.on('error', (err) => {
    logger.error('Error serving file:', err);

    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
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
