import type { TMessageMetadata } from '@pulse/shared';
import { federationFetch } from '../../utils/federation-fetch';

/**
 * Link-preview fetcher for user-posted URLs. Replaces a library that
 * read the whole body (`response.text()` with no cap), re-resolved DNS
 * on its own and parsed arbitrary-size HTML on the single Bun thread —
 * any member could make the server download and parse a slow-dripped
 * 100 MB page per message.
 *
 * Pipeline: `federationFetch` (SSRF validation, pinned address, no
 * redirects, per-host rate limit) → content-type gate (only HTML is
 * parsed; anything else yields a bare `{ url, mediaType }` so an image
 * or video link still renders as a link) → body capped at
 * MAX_HTML_BYTES through the streaming reader → `<title>` and the
 * og:/twitter:/standard meta tags via the runtime's streaming HTML
 * rewriter, so the parse is linear in the (bounded) body and needs no
 * DOM.
 */

/** Largest HTML document read for a preview; the rest is cut off. */
const MAX_HTML_BYTES = 512 * 1024;
/** Per-URL network budget. */
const FETCH_TIMEOUT_MS = 5000;

/** Longest text kept per field — a preview card, not an article. */
const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_SITE_NAME_LENGTH = 128;
/** Most media URLs kept per kind. */
const MAX_URLS_PER_KIND = 5;
const MAX_URL_LENGTH = 2048;

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

/**
 * The streaming rewriter hands text and attribute values back raw, so
 * `&amp;` in a title would reach the card verbatim. Named entities that
 * appear in titles plus numeric references cover real-world pages.
 */
const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });

const cleanText = (value: string, max: number): string | undefined => {
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
};

/** Absolute http(s) URL for a (possibly relative) page reference. */
const absoluteHttpUrl = (value: string, base: URL): string | undefined => {
  try {
    const resolved = new URL(decodeEntities(value).trim(), base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return undefined;
    }
    return resolved.href.length <= MAX_URL_LENGTH ? resolved.href : undefined;
  } catch {
    return undefined;
  }
};

const pushUnique = (list: string[], value: string | undefined) => {
  if (value && !list.includes(value) && list.length < MAX_URLS_PER_KIND) {
    list.push(value);
  }
};

/** Charset from a Content-Type header, if the runtime knows it. */
const decoderFor = (contentType: string): TextDecoder => {
  const charset = contentType.match(/charset=["']?([\w.-]+)/i)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]);
    } catch {
      // Unknown label — fall through to UTF-8 rather than fail the preview.
    }
  }
  return new TextDecoder();
};

/** The primary type ("image" of "image/png"); "website" for HTML. */
const mediaTypeOf = (contentType: string, isHtml: boolean): string => {
  if (isHtml) return 'website';
  const primary = contentType.split(';')[0]?.split('/')[0]?.trim().toLowerCase();
  return primary || 'application';
};

type ParsedPage = {
  title?: string;
  description?: string;
  siteName?: string;
  type?: string;
  images: string[];
  videos: string[];
  favicons: string[];
};

/**
 * One streaming pass over the capped HTML. Only `<head>`-level tags
 * matter; `og:*` beats `twitter:*` beats the plain `<title>` /
 * `description` for the same field, matching what the card shows.
 */
const parseHtml = async (html: string, pageUrl: URL): Promise<ParsedPage> => {
  const page: ParsedPage = { images: [], videos: [], favicons: [] };
  let titleText = '';
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  let metaDescription: string | undefined;

  const rewriter = new HTMLRewriter()
    .on('title', {
      text(chunk) {
        if (titleText.length < MAX_TITLE_LENGTH * 4) titleText += chunk.text;
      }
    })
    .on('meta', {
      element(el) {
        const content = el.getAttribute('content');
        if (!content) return;
        const property = (el.getAttribute('property') ?? '').toLowerCase();
        const name = (el.getAttribute('name') ?? '').toLowerCase();
        const key = property || name;
        if (key.startsWith('og:')) {
          const field = key.slice(3);
          if (!(field in og)) og[field] = content;
        } else if (key.startsWith('twitter:')) {
          const field = key.slice(8);
          if (!(field in twitter)) twitter[field] = content;
        } else if (key === 'description' && metaDescription === undefined) {
          metaDescription = content;
        }
      }
    })
    .on('link', {
      element(el) {
        const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
        const href = el.getAttribute('href');
        if (!href) return;
        if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
          pushUnique(page.favicons, absoluteHttpUrl(href, pageUrl));
        }
      }
    });

  // The rewriter only runs while its output is consumed.
  await rewriter.transform(new Response(html)).arrayBuffer();

  page.title = cleanText(
    og.title ?? twitter.title ?? titleText,
    MAX_TITLE_LENGTH
  );
  page.description = cleanText(
    og.description ?? twitter.description ?? metaDescription ?? '',
    MAX_DESCRIPTION_LENGTH
  );
  page.siteName = cleanText(og.site_name ?? '', MAX_SITE_NAME_LENGTH);
  page.type = cleanText(og.type ?? '', 64);

  for (const key of ['image', 'image:secure_url', 'image:url']) {
    if (og[key]) pushUnique(page.images, absoluteHttpUrl(og[key], pageUrl));
  }
  if (twitter.image) pushUnique(page.images, absoluteHttpUrl(twitter.image, pageUrl));
  for (const key of ['video', 'video:secure_url', 'video:url']) {
    if (og[key]) pushUnique(page.videos, absoluteHttpUrl(og[key], pageUrl));
  }
  if (page.favicons.length === 0) {
    pushUnique(page.favicons, absoluteHttpUrl('/favicon.ico', pageUrl));
  }

  return page;
};

/**
 * Fetch and summarise one URL for a preview card. Returns undefined
 * when the page cannot be previewed (non-2xx, no body); throws on the
 * hard failures (validation, redirect, timeout, body over the cap) so
 * the caller's allSettled drops just that URL.
 */
export const fetchLinkPreview = async (
  urlString: string
): Promise<TMessageMetadata | undefined> => {
  const response = await federationFetch(urlString, {
    headers: {
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      'User-Agent': 'Mozilla/5.0 (compatible; PulseLinkPreview/1.0)'
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    maxBytes: MAX_HTML_BYTES
  });

  if (!response.ok) return undefined;

  const contentType = response.headers.get('content-type') ?? '';
  const isHtml = /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType.trim());

  if (!isHtml) {
    // Nothing to parse; drop the body without reading it.
    await response.body?.cancel().catch(() => {});
    return { url: urlString, mediaType: mediaTypeOf(contentType, false) };
  }

  // Over-cap bodies throw here — a hard failure like a timeout, never a
  // half-parsed page.
  const html = decoderFor(contentType).decode(await response.bytes());
  const page = await parseHtml(html, new URL(urlString));

  const metadata: TMessageMetadata = {
    url: urlString,
    mediaType: page.type ?? mediaTypeOf(contentType, true)
  };
  if (page.title) metadata.title = page.title;
  if (page.description) metadata.description = page.description;
  if (page.siteName) metadata.siteName = page.siteName;
  if (page.images.length) metadata.images = page.images;
  if (page.videos.length) metadata.videos = page.videos;
  if (page.favicons.length) metadata.favicons = page.favicons;

  return metadata;
};

export { MAX_HTML_BYTES, decodeEntities as _decodeEntities };
