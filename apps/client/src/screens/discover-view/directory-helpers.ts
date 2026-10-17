import { getPublicFileUrl } from '@/helpers/get-file-url';
import {
  DIRECTORY_DESCRIPTION_MAX_LENGTH,
  DIRECTORY_GAME_MAX_LENGTH,
  DIRECTORY_TAG_MAX_LENGTH,
  DIRECTORY_TAGS_MAX
} from '@pulse/shared';
import type { TDirectoryEntry } from '@pulse/server/types';

/**
 * Pure helpers behind the Directory section and the opt-in form —
 * kept out of the components so they are unit-testable without a DOM.
 */

/** Stable React key: the same publicId can exist on two instances. */
const directoryEntryKey = (entry: TDirectoryEntry): string =>
  `${entry.source}:${entry.instance?.domain ?? 'home'}:${entry.publicId}`;

/**
 * The card image. A local row names a /public/ file on the home
 * instance; a federated row already carries the absolute URL the
 * puller built from the peer's advertised domain.
 */
const directoryLogoSrc = (
  entry: Pick<TDirectoryEntry, 'source' | 'logo'>
): string => {
  if (!entry.logo) return '';
  return entry.source === 'local' ? getPublicFileUrl(entry.logo) : entry.logo;
};

const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** "12 members · 3 online" — the card's second line. */
const formatDirectoryCounts = (memberCount: number, onlineCount: number) =>
  `${plural(memberCount, 'member')} · ${onlineCount.toLocaleString()} online`;

/**
 * How stale a federated card is, from its `fetchedAt`. Rounded to the
 * unit that reads naturally; nothing is shown inside the first hour.
 */
const formatFetchedAgo = (fetchedAt: number, now = Date.now()): string | null => {
  const ageMs = Math.max(0, now - fetchedAt);
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours < 1) return null;
  if (hours < 24) return `updated ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `updated ${days} day${days === 1 ? '' : 's'} ago`;
};

/**
 * The tags field is typed as free text: split on commas or newlines,
 * trim, drop empties and case-insensitive duplicates, keep the first
 * DIRECTORY_TAGS_MAX. Over-long tags are kept so the form can show the
 * limit instead of silently cutting them.
 */
const parseTagsInput = (text: string): string[] => {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === DIRECTORY_TAGS_MAX) break;
  }
  return tags;
};

type TDirectoryCardInput = {
  listed: boolean;
  description: string;
  tagsText: string;
  game: string;
  discoverable: boolean;
  allowNewUsers: boolean;
};

type TDirectoryCardErrors = Partial<
  Record<'directoryListed' | 'directoryDescription' | 'directoryTags' | 'directoryGame', string>
>;

/** Client-side mirror of the opt-in route's bounds, for inline errors. */
const validateDirectoryCard = (input: TDirectoryCardInput): TDirectoryCardErrors => {
  const errors: TDirectoryCardErrors = {};

  if (input.listed && !(input.discoverable && input.allowNewUsers)) {
    errors.directoryListed =
      'A listed server must be discoverable and accepting new members';
  }
  if (input.description.trim().length > DIRECTORY_DESCRIPTION_MAX_LENGTH) {
    errors.directoryDescription = `Keep the description to ${DIRECTORY_DESCRIPTION_MAX_LENGTH} characters`;
  }
  const rawTags = input.tagsText
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (rawTags.some((t) => t.length > DIRECTORY_TAG_MAX_LENGTH)) {
    errors.directoryTags = `Each tag can be up to ${DIRECTORY_TAG_MAX_LENGTH} characters`;
  } else if (parseTagsInput(input.tagsText).length < new Set(rawTags.map((t) => t.toLowerCase())).size) {
    errors.directoryTags = `Up to ${DIRECTORY_TAGS_MAX} tags`;
  }
  if (input.game.trim().length > DIRECTORY_GAME_MAX_LENGTH) {
    errors.directoryGame = `Keep the game to ${DIRECTORY_GAME_MAX_LENGTH} characters`;
  }

  return errors;
};

/** The join routes' password refusal, as the toast text matches it. */
const isInvalidPasswordError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('Invalid password');

export {
  directoryEntryKey,
  directoryLogoSrc,
  formatDirectoryCounts,
  formatFetchedAgo,
  isInvalidPasswordError,
  parseTagsInput,
  validateDirectoryCard,
  type TDirectoryCardErrors
};
