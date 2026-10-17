import { UploadHeaders } from '@pulse/shared';
import fs from 'fs';
import http from 'http';
import path from 'path';
import z from 'zod';
import { getFirstServer } from '../db/queries/servers';
import { logger } from '../logger';
import { fileManager } from '../utils/file-manager';
import { resolveAuthenticatedUser } from '../utils/resolve-auth';

// Defense in depth only. The real protection against a stored upload
// executing on the app origin is in /public (http/public.ts): every
// response there carries a sandboxing CSP, and only image/video/audio/
// pdf types are served inline — everything else is an
// application/octet-stream attachment. This list keeps the obviously
// scriptable/renderable types (as Bun.file(...).type maps them) out of
// storage in the first place.
const BLOCKED_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.shtml',
  '.shtm',
  '.xhtml',
  '.xht',
  '.xhtm',
  '.xml',
  '.xsl',
  '.xslt',
  '.mathml',
  '.xul',
  '.rss',
  '.atom',
  '.svg',
  '.svgz',
  '.webmanifest',
  '.php',
  '.jsp',
  '.asp',
  '.aspx',
  '.cgi',
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.ps1',
  '.msi',
  '.dll',
  '.com',
  '.scr',
  '.pif',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.es',
  '.htc',
  '.vbs',
  '.wsf',
  '.hta'
]);

const zHeaders = z.object({
  [UploadHeaders.TOKEN]: z.string(),
  [UploadHeaders.ORIGINAL_NAME]: z.string(),
  // A malformed Content-Length used to become NaN and sail past the
  // size comparison; now it is a 400 like any other bad header.
  [UploadHeaders.CONTENT_LENGTH]: z.coerce.number().int().nonnegative(),
  [UploadHeaders.ENCRYPTED]: z.string().optional()
});

const QUOTA_MESSAGES = {
  user: 'User storage limit exceeded',
  server: 'Server storage limit exceeded.'
} as const;

/** Drain the request body, then answer — avoids resetting the client
 * mid-upload for a verdict we can give from the headers alone. */
const rejectAfterDrain = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  error: string
) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
  });
};

const uploadFileRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const parsedHeaders = zHeaders.parse(req.headers);
  const [token, originalName, contentLength] = [
    parsedHeaders[UploadHeaders.TOKEN],
    parsedHeaders[UploadHeaders.ORIGINAL_NAME],
    parsedHeaders[UploadHeaders.CONTENT_LENGTH]
  ];
  // The encrypted flag is opt-in client-side. When true, the upload's
  // body is ciphertext and `originalName` is a placeholder UUID — the
  // server stores it as-is, marks files.encrypted = true, and never
  // sees the real metadata (which lives inside the E2EE message
  // envelope's fileKeys).
  const isEncrypted = parsedHeaders[UploadHeaders.ENCRYPTED] === 'true';

  // Authenticate via standard token or federation token (both are validated)
  const federationToken = req.headers['x-federation-token'] as
    | string
    | undefined;
  const auth = await resolveAuthenticatedUser({
    accessToken: token,
    federationToken
  });

  if (!auth) {
    req.resume();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const user = auth.user;

  const server = await getFirstServer();

  if (!server) {
    req.resume();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server not found' }));
    return;
  }

  if (contentLength > server.storageUploadMaxFileSize) {
    rejectAfterDrain(
      req,
      res,
      413,
      `File ${originalName} exceeds the maximum allowed size`
    );
    return;
  }

  const ext = path.extname(originalName).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    rejectAfterDrain(req, res, 400, `File type ${ext} is not allowed`);
    return;
  }

  if (!server.storageUploadEnabled) {
    rejectAfterDrain(req, res, 403, 'File uploads are disabled on this server');
    return;
  }

  // The declared length is a claim, but a truthful client over its
  // quota gets its answer here instead of after streaming 100 MB into
  // a temp area that saveFile would then refuse. The streamed byte count
  // below and saveFile's own check remain the hard stops.
  if (contentLength === 0) {
    rejectAfterDrain(req, res, 400, 'Empty files cannot be uploaded');
    return;
  }

  const quotaViolation = await fileManager.getStorageViolation(
    user.id,
    contentLength
  );

  if (quotaViolation) {
    rejectAfterDrain(req, res, 413, QUOTA_MESSAGES[quotaViolation]);
    return;
  }

  const safePath = await fileManager.getSafeUploadPath(originalName);
  const fileStream = fs.createWriteStream(safePath);

  // Enforce the size cap on the actual byte stream — the Content-Length
  // header is a claim the client can lie about. Without this, a client that
  // sends `Content-Length: 100` but streams gigabytes will fill disk.
  const sizeLimit = server.storageUploadMaxFileSize;
  let bytesReceived = 0;
  let exceeded = false;

  req.on('data', (chunk: Buffer) => {
    if (exceeded) return;
    bytesReceived += chunk.length;
    if (bytesReceived > sizeLimit) {
      exceeded = true;
      // Tear down both ends and clean up the partial file. Best-effort —
      // any unlink/destroy errors are logged at error level downstream.
      fileStream.destroy();
      req.destroy();
      fs.unlink(safePath, () => {});
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `File ${originalName} exceeds the maximum allowed size`
          })
        );
      }
    }
  });

  req.pipe(fileStream);

  fileStream.on('finish', async () => {
    if (exceeded || res.headersSent) return;

    // Chunked uploads can declare 0 and still send bytes, or declare a
    // length and send nothing: the stream is the truth.
    if (bytesReceived === 0) {
      fs.unlink(safePath, () => {});
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Empty files cannot be uploaded' }));
      return;
    }

    try {
      const tempFile = await fileManager.addTemporaryFile({
        originalName,
        filePath: safePath,
        size: bytesReceived,
        userId: user.id,
        encrypted: isEncrypted
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tempFile));
    } catch (error) {
      logger.error('Error processing uploaded file:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File processing failed' }));
      }
    }
  });

  fileStream.on('error', (err) => {
    if (exceeded || res.headersSent) return;
    logger.error('Error uploading file:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File upload failed' }));
  });
};

export { BLOCKED_EXTENSIONS, uploadFileRouteHandler };
