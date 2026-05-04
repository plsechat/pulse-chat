/**
 * Bounded image fetch for federation proxies (Phase 4 / F3 + F4).
 *
 * F3: Streams the response body and aborts if the accumulated byte
 *     count exceeds `maxBytes`. Stops a hostile peer (or an
 *     accidentally-misconfigured one) from gigabyte-bombing our disk
 *     via the avatar/file proxy paths.
 *
 * F4: Sniffs the first bytes for a known image magic prefix (PNG,
 *     JPEG, GIF, WebP) and returns the *sniffed* MIME type rather
 *     than trusting the remote's Content-Type header. Anything that
 *     doesn't match is rejected — e.g. an HTML 404 page styled as an
 *     image, or an executable served as image/png. The proxied file's
 *     Content-Type when later served from `/public/` is therefore the
 *     sniffed type, never the attacker-controlled remote header.
 *
 * Returns a buffer (the streamed bytes), the sniffed MIME type, and
 * the canonical extension. Throws on size overflow, on unsniffable
 * content, on non-2xx response, or on any underlying fetch error.
 */

import { federationFetch } from './federation-fetch';

export type SniffedImage = {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  extension: '.png' | '.jpg' | '.gif' | '.webp';
};

export class FederatedMediaTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Federated media exceeded ${maxBytes} bytes`);
    this.name = 'FederatedMediaTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export class FederatedMediaUnknownTypeError extends Error {
  constructor(claimedContentType: string | null) {
    super(
      `Federated media did not match any known image magic prefix (claimed Content-Type: ${claimedContentType ?? 'none'})`
    );
    this.name = 'FederatedMediaUnknownTypeError';
  }
}

function sniff(buf: Uint8Array): SniffedImage | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { bytes: buf, mimeType: 'image/png', extension: '.png' };
  }

  // JPEG (any framing): FF D8 FF
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return { bytes: buf, mimeType: 'image/jpeg', extension: '.jpg' };
  }

  // GIF: 47 49 46 38 (GIF8) — both GIF87a and GIF89a start this way
  if (
    buf.length >= 4 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    return { bytes: buf, mimeType: 'image/gif', extension: '.gif' };
  }

  // WebP: RIFF....WEBP — first 4 are 'RIFF', bytes 8-11 are 'WEBP'
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { bytes: buf, mimeType: 'image/webp', extension: '.webp' };
  }

  return null;
}

/**
 * Decide based on partial bytes whether the prefix CAN'T be a valid
 * image. Used to fail fast during streaming — no need to download a
 * 50MB body if the first 12 bytes already disprove every image
 * magic.
 */
function definitelyNotImage(prefix: Uint8Array): boolean {
  if (prefix.length === 0) return false;
  // All four image families have distinct first bytes.
  return (
    prefix[0] !== 0x89 && // PNG
    prefix[0] !== 0xff && // JPEG
    prefix[0] !== 0x47 && // GIF
    prefix[0] !== 0x52 // WebP RIFF
  );
}

export async function fetchBoundedImage(
  url: string,
  maxBytes: number,
  fetchInit?: RequestInit
): Promise<SniffedImage> {
  const response = await federationFetch(url, fetchInit);
  if (!response.ok) {
    throw new Error(
      `Federated media fetch returned status ${response.status} for ${url}`
    );
  }

  // Honor the Content-Length header as a fast-fail before we even
  // start reading. Hostile peers can lie about it, so the streaming
  // check below is still authoritative.
  const declaredLen = parseInt(
    response.headers.get('content-length') || '0',
    10
  );
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    throw new FederatedMediaTooLargeError(maxBytes);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`Federated media fetch returned no body for ${url}`);
  }

  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  let earlyRejected = false;

  try {
    // Stream until done or we hit a fail-fast condition. The
    // condition expression below cannot be `true` because the
    // no-constant-condition rule rejects it; using `!earlyRejected`
    // is functionally equivalent (the in-loop fail-fast paths set
    // it before they break) and keeps the lint happy.
    while (!earlyRejected) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      chunks.push(value);
      totalLen += value.byteLength;

      if (totalLen > maxBytes) {
        earlyRejected = true;
        break;
      }

      // After we have at least 12 bytes, fail fast on non-image
      // content rather than streaming the whole body to discover it
      // wasn't an image.
      if (totalLen >= 12 && chunks.length === 1 && definitelyNotImage(chunks[0]!)) {
        earlyRejected = true;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
  }

  if (earlyRejected) {
    if (totalLen > maxBytes) {
      throw new FederatedMediaTooLargeError(maxBytes);
    }
    throw new FederatedMediaUnknownTypeError(
      response.headers.get('content-type')
    );
  }

  // Concatenate.
  const buf = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const sniffed = sniff(buf);
  if (!sniffed) {
    throw new FederatedMediaUnknownTypeError(
      response.headers.get('content-type')
    );
  }
  return sniffed;
}
