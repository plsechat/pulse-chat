import { getPublicFileUrl } from '@/helpers/get-file-url';
import {
  DIRECTORY_DESCRIPTION_MAX_LENGTH,
  DIRECTORY_GAME_MAX_LENGTH,
  DIRECTORY_TAG_MAX_LENGTH,
  DIRECTORY_TAG_PATTERN,
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

/** Tags are stored bare and shown with a leading # everywhere. */
const displayTag = (tag: string): string => `#${tag}`;

type TDirectoryCardInput = {
  listed: boolean;
  description: string;
  tags: string[];
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
  if (input.tags.some((t) => t.length > DIRECTORY_TAG_MAX_LENGTH)) {
    errors.directoryTags = `Each tag can be up to ${DIRECTORY_TAG_MAX_LENGTH} characters`;
  } else if (input.tags.some((t) => !DIRECTORY_TAG_PATTERN.test(t))) {
    errors.directoryTags = 'Tags may contain letters, numbers, spaces, _ and -';
  } else if (input.tags.length > DIRECTORY_TAGS_MAX) {
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
  displayTag,
  formatDirectoryCounts,
  formatFetchedAgo,
  isInvalidPasswordError,
  validateDirectoryCard,
  type TDirectoryCardErrors
};
