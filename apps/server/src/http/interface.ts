import fs from 'fs';
import http from 'http';
import path from 'path';
import { INTERFACE_PATH } from '../helpers/paths';
import { logger } from '../logger';
import { IS_DEVELOPMENT, IS_TEST } from '../utils/env';

/**
 * Vite writes a content hash into every `/assets/*` name, so those
 * bytes never change under a given URL and can be cached forever; the
 * document that references them must always be revalidated or a client
 * keeps loading a bundle the server no longer ships. Everything else
 * under the interface root (fonts, favicons, manifest) is unhashed but
 * rarely changes: a day is long enough to stop the re-fetch on every
 * load and short enough that a redesign lands without a hard refresh.
 */
const cacheControlFor = (cleanSubPath: string): string => {
  if (cleanSubPath.startsWith('assets/')) {
    return 'public, max-age=31536000, immutable';
  }

  if (cleanSubPath === 'index.html') {
    return 'no-cache';
  }

  return 'public, max-age=86400';
};

// Cache the "is the interface dir populated?" check so we don't stat
// the directory on every request. Resolved once on first request.
let _hasInterfaceFiles: boolean | undefined;
function hasInterfaceFiles(): boolean {
  if (_hasInterfaceFiles !== undefined) return _hasInterfaceFiles;
  try {
    const indexPath = path.join(INTERFACE_PATH, 'index.html');
    _hasInterfaceFiles = fs.existsSync(indexPath);
  } catch {
    _hasInterfaceFiles = false;
  }
  return _hasInterfaceFiles;
}

const interfaceRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  // Dev redirect to vite-dev only when the interface dir is empty —
  // i.e. nobody pre-seeded a built bundle. Test-deploy / docker
  // runtime-mode pre-seeds the bundle so this branch falls through
  // to the static-file serve below.
  if (IS_DEVELOPMENT && !IS_TEST && !hasInterfaceFiles()) {
    res.writeHead(302, { Location: 'http://localhost:5173' });
    res.end();
    return res;
  }

  let subPath = req.url || '/';

  const urlPart = subPath.split('?')[0];

  try {
    subPath = urlPart ? decodeURIComponent(urlPart) : '/';
  } catch {
    // Malformed percent-encoding is a client error, not a 500.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return res;
  }

  subPath = subPath === '/' ? 'index.html' : subPath;

  const cleanSubPath = subPath.startsWith('/') ? subPath.slice(1) : subPath;

  const requestedPath = path.resolve(INTERFACE_PATH, cleanSubPath);
  const basePath = path.resolve(INTERFACE_PATH);

  // Compare against the directory boundary, not the bare prefix:
  // INTERFACE_PATH is versioned (data/interface/<ver>), so a sibling
  // such as data/interface/<ver>-rc1 would otherwise pass as "inside".
  if (!requestedPath.startsWith(basePath + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return res;
  }

  if (!fs.existsSync(requestedPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return res;
  }

  const stats = fs.statSync(requestedPath);

  if (stats.isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return res;
  }

  const file = Bun.file(requestedPath);
  const fileStream = fs.createReadStream(requestedPath);

  fileStream.on('open', () => {
    res.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': file.size,
      'Cache-Control': cacheControlFor(cleanSubPath)
    });
    fileStream.pipe(res);
  });

  fileStream.on('error', (err) => {
    logger.error('Error serving file:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    } else {
      res.destroy();
    }
  });

  res.on('close', () => {
    fileStream.destroy();
  });

  return res;
};

export { interfaceRouteHandler };
