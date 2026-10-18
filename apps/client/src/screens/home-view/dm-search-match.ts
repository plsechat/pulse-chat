import { stripToPlainText } from '@/helpers/strip-to-plain-text';
import type { TJoinedDmMessage } from '@pulse/server/types';

/**
 * Client-side matcher for searching an encrypted DM (audit A8-15). The
 * server's `dms.searchMessages` can only ILIKE over plaintext rows and
 * excludes `e2ee` ones, so an encrypted conversation is searched over
 * the messages THIS device has decrypted: the dms slice window plus
 * older pages resolved through the plaintext caches.
 *
 * Matching mirrors the server: case-insensitive substring over the
 * readable text (tokens such as `<@12>` resolve to `@user`, markdown
 * markers are dropped), newest first. Messages whose content is an
 * E2EE placeholder are never a hit — the user cannot read them either.
 */

/** Placeholders the decrypt pipeline leaves when it has no plaintext. */
const UNREADABLE = new Set(['[Unable to decrypt]', '[Encrypted message]']);

export const normalizeDmSearchQuery = (query: string): string =>
  query.trim().toLocaleLowerCase();

/** True when `message` is readable and its text contains `query`. */
export const dmMessageMatches = (
  message: Pick<TJoinedDmMessage, 'content'>,
  query: string
): boolean => {
  const normalized = normalizeDmSearchQuery(query);
  if (!normalized) return false;
  const { content } = message;
  if (!content || UNREADABLE.has(content)) return false;
  return stripToPlainText(content)
    .toLocaleLowerCase()
    .includes(normalized);
};

/**
 * The hits in `messages` for `query`, newest first, deduplicated by id
 * (the slice window and a server page can overlap at the seam).
 */
export const matchDmMessages = <T extends TJoinedDmMessage>(
  messages: readonly T[],
  query: string
): T[] => {
  const normalized = normalizeDmSearchQuery(query);
  if (!normalized) return [];
  const seen = new Set<number>();
  const hits: T[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    if (!dmMessageMatches(message, normalized)) continue;
    seen.add(message.id);
    hits.push(message);
  }
  return hits.sort(
    (a, b) => b.createdAt - a.createdAt || b.id - a.id
  );
};

/**
 * Merge a new batch of hits into an existing newest-first result list
 * without duplicates (older pages arrive after the slice hits).
 */
export const appendDmSearchHits = <T extends TJoinedDmMessage>(
  existing: readonly T[],
  incoming: readonly T[]
): T[] => {
  const seen = new Set(existing.map((m) => m.id));
  const merged = [...existing];
  for (const message of incoming) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
};
