import { UploadHeaders } from '@pulse/shared';
import fs from 'fs';
import http from 'http';
import path from 'path';
import z from 'zod';
import { findOrCreateShadowUser } from '../db/mutations/federation';
import { getFirstServer } from '../db/queries/servers';
import { getUserByToken } from '../db/queries/users';
import { logger } from '../logger';
import { verifyFederationToken } from '../utils/federation';
import { fileManager } from '../utils/file-manager';

const BLOCKED_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.xml', '.svg',
  '.php', '.jsp', '.asp', '.aspx', '.cgi',
  '.exe', '.bat', '.cmd', '.sh', '.ps1',
  '.msi', '.dll', '.com', '.scr', '.pif',
  '.js', '.mjs', '.vbs', '.wsf', '.hta'
]);

const zHeaders = z.object({
  [UploadHeaders.TOKEN]: z.string(),
  [UploadHeaders.ORIGINAL_NAME]: z.string(),
  [UploadHeaders.CONTENT_LENGTH]: z.string().transform((val) => Number(val))
});

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

  // Authenticate via standard token or federation token (both are validated)
  const federationToken = req.headers['x-federation-token'] as string | undefined;
  const user = federationToken
    ? await (async () => {
        const fedResult = await verifyFederationToken(federationToken);
        if (!fedResult) return undefined;
        return findOrCreateShadowUser(
          fedResult.instanceId,
          fedResult.userId,
          fedResult.username,
          undefined,
          fedResult.publicId
        );
      })()
    : await getUserByToken(token);

  if (!user) {
    req.resume();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const server = await getFirstServer();

  if (!server) {
    req.resume();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server not found' }));
    return;
  }

  if (contentLength > server.storageUploadMaxFileSize) {
    req.resume();
    req.on('end', () => {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `File ${originalName} exceeds the maximum allowed size`
        })
      );
    });

    return;
  }

  const ext = path.extname(originalName).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: `File type ${ext} is not allowed` })
      );
    });

    return;
  }

  if (!server.storageUploadEnabled) {
    req.resume();
    req.on('end', () => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'File uploads are disabled on this server' })
      );
    });

    return;
  }

  const safePath = await fileManager.getSafeUploadPath(originalName);
  const fileStream = fs.createWriteStream(safePath);

  req.pipe(fileStream);

  fileStream.on('finish', async () => {
    try {
      const tempFile = await fileManager.addTemporaryFile({
        originalName,
        filePath: safePath,
        size: contentLength,
        userId: user.id
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tempFile));
    } catch (error) {
      logger.error('Error processing uploaded file:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File processing failed' }));
    }
  });

  fileStream.on('error', (err) => {
    logger.error('Error uploading file:', err);

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File upload failed' }));
  });
};

export { uploadFileRouteHandler };
