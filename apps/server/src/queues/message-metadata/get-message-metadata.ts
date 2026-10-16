import type { TMessageMetadata } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { messages } from '../../db/schema';
import { validateFederationUrl } from '../../utils/validate-url';
import { fetchLinkPreview } from './fetch-link-preview';

type TLinkPreview = TMessageMetadata;

/** Fetches one preview; injectable so tests count calls without network. */
type TLinkPreviewFetcher = (url: string) => Promise<TLinkPreview | undefined>;

/** Most URLs previewed per message — the rest are posted as plain links. */
const MAX_PREVIEW_URLS_PER_MESSAGE = 5;
/** One deadline for the whole message's batch of fetches. */
const LINK_PREVIEW_DEADLINE_MS = 8000;
/** Queue job timeout; must stay ABOVE the deadline (see queue index). */
const LINK_PREVIEW_JOB_TIMEOUT_MS = 10_000;

const CACHE_MAX_ENTRIES = 1000;
const CACHE_TTL_MS = 1000 * 60 * 60 * 2;

const URL_PATTERN = /https?:\/\/[^\s]+/g;

/**
 * Cheap pre-check for enqueue sites: a message without an http(s) URL
 * has nothing to preview and must not cost a job, an UPDATE and a
 * MESSAGE_UPDATE fan-out.
 */
const hasLinkPreviewCandidate = (content: string): boolean =>
  /https?:\/\//i.test(content);

/**
 * Bounded LRU with a TTL: the old unbounded Map wiped every 2 h held
 * hours of previews (KBs each) between clears.
 */
class PreviewCache {
  private entries = new Map<string, { value: TLinkPreview; expires: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number
  ) {}

  get(url: string): TLinkPreview | undefined {
    const entry = this.entries.get(url);

    if (!entry) return undefined;

    if (entry.expires <= Date.now()) {
      this.entries.delete(url);
      return undefined;
    }

    // Map iteration order is insertion order; re-inserting marks the
    // entry as most recently used.
    this.entries.delete(url);
    this.entries.set(url, entry);

    return entry.value;
  }

  set(url: string, value: TLinkPreview) {
    this.entries.delete(url);
    this.entries.set(url, { value, expires: Date.now() + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;

      if (oldest === undefined) break;

      this.entries.delete(oldest);
    }
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}

const metadataCache = new PreviewCache(CACHE_MAX_ENTRIES, CACHE_TTL_MS);

// The fetcher dials the address the validator checked (no re-resolve),
// refuses redirects, caps the body and only parses HTML — see
// fetch-link-preview.ts.
const defaultFetcher: TLinkPreviewFetcher = fetchLinkPreview;

/**
 * Candidate URLs for preview: unique, giphy excluded (rendered inline
 * by the client already), capped at MAX_PREVIEW_URLS_PER_MESSAGE.
 */
const extractPreviewUrls = (content: string): string[] => {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const url of content.match(URL_PATTERN) ?? []) {
    if (seen.has(url)) continue;
    seen.add(url);

    try {
      const parsed = new URL(url);
      // Block giphy domains by checking the registered domain
      const parts = parsed.hostname.split('.');
      const baseDomain = parts.slice(-2).join('.');
      if (baseDomain === 'giphy.com') continue;
    } catch {
      continue;
    }

    urls.push(url);

    if (urls.length >= MAX_PREVIEW_URLS_PER_MESSAGE) break;
  }

  return urls;
};

/** Rejects when the shared deadline passes, whatever the fetch is doing. */
const withDeadline = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Timed out'));

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });

export const urlMetadataParser = async (
  content: string,
  fetchPreview: TLinkPreviewFetcher = defaultFetcher
): Promise<TMessageMetadata[]> => {
  const urls = extractPreviewUrls(content);

  if (urls.length === 0) return [];

  const deadline = AbortSignal.timeout(LINK_PREVIEW_DEADLINE_MS);

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const cached = metadataCache.get(url);

      if (cached) return cached;

      // Validate URL is not targeting internal/private resources.
      await validateFederationUrl(url);

      const metadata = await withDeadline(fetchPreview(url), deadline);

      if (!metadata) return undefined;

      metadataCache.set(url, metadata);

      return metadata;
    })
  );

  // A failed or slow URL only loses its own preview; the others still
  // land (allSettled, not all).
  return results.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : []
  );
};

/**
 * Resolves previews and stores them on the message. Returns null when
 * there is nothing to store — the caller then skips the MESSAGE_UPDATE
 * fan-out (mirrors the DM twin).
 */
export const processMessageMetadata = async (
  content: string,
  messageId: number,
  fetchPreview?: TLinkPreviewFetcher
) => {
  const metadata = await urlMetadataParser(content, fetchPreview);

  if (metadata.length === 0) return null;

  const [updatedMessage] = await db
    .update(messages)
    .set({
      metadata,
      updatedAt: Date.now()
    })
    .where(eq(messages.id, messageId))
    .returning();

  return updatedMessage ?? null;
};

export {
  hasLinkPreviewCandidate,
  LINK_PREVIEW_JOB_TIMEOUT_MS,
  MAX_PREVIEW_URLS_PER_MESSAGE,
  metadataCache,
  PreviewCache
};
