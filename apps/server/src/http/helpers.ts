import http from 'http';

/**
 * Default cap for JSON request bodies (64 KB) — comfortably above
 * any legitimate auth/registration/preference payload, well below the
 * point where `body += chunk` becomes a memory-pressure vector. Bun is
 * single-threaded so an unbounded body parser on a public endpoint
 * (login/register/provision/webhook) is a trivial DoS surface.
 *
 * Per pulse-rule-input-bounds.md: every public ingestion path needs
 * an explicit cap. Federation already has its own cap in `parseBody`
 * (1 MB); webhooks pass 256 KB; normal app endpoints stay at the
 * 64 KB default.
 */
const DEFAULT_JSON_BODY_LIMIT = 64 * 1024;

class JsonBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeded ${limit} bytes`);
    this.name = 'JsonBodyTooLargeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const getJsonBody = async <T = unknown>(
  req: http.IncomingMessage,
  options: { maxBytes?: number } = {}
): Promise<T> => {
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_BODY_LIMIT;

  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.removeAllListeners('error');
    };

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        cleanup();
        // Drain so the client doesn't keep streaming after we've decided.
        req.resume();
        reject(new JsonBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      cleanup();
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        const json = body ? JSON.parse(body) : {};
        resolve(json);
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
};

export { getJsonBody, JsonBodyTooLargeError };
