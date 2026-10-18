import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import type { TVoiceUserState } from '@pulse/shared';

/**
 * Pure helpers behind the soundboard grid: ordering (favourites first,
 * then by name), search, the starred set in localStorage, and the two
 * rules the player applies locally. Kept free of React so they are
 * unit-testable and shared by the grid and the player.
 */

export type TSoundboardEntry = {
  id: number;
  name: string;
  emoji: string | null;
  volume: number;
};

/** Favourites first (each group alphabetical, case-insensitive). */
export const sortSounds = <T extends TSoundboardEntry>(
  sounds: readonly T[],
  favouriteIds: ReadonlySet<number>
): T[] =>
  [...sounds].sort((a, b) => {
    const fa = favouriteIds.has(a.id) ? 0 : 1;
    const fb = favouriteIds.has(b.id) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

/** Name or emoji contains the query (trimmed, case-insensitive); empty query keeps all. */
export const filterSounds = <T extends TSoundboardEntry>(
  sounds: readonly T[],
  query: string
): T[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [...sounds];
  return sounds.filter(
    (s) => s.name.toLowerCase().includes(q) || (s.emoji ?? '').includes(q)
  );
};

export const toggleFavourite = (
  favouriteIds: ReadonlySet<number>,
  soundId: number
): Set<number> => {
  const next = new Set(favouriteIds);
  if (next.has(soundId)) next.delete(soundId);
  else next.add(soundId);
  return next;
};

export const loadFavouriteSoundIds = (): Set<number> => {
  try {
    const stored = getLocalStorageItemAsJSON<unknown>(
      LocalStorageKey.SOUNDBOARD_FAVOURITES
    );
    if (!Array.isArray(stored)) return new Set();
    return new Set(
      stored.filter((v): v is number => typeof v === 'number' && Number.isInteger(v))
    );
  } catch {
    return new Set();
  }
};

export const saveFavouriteSoundIds = (ids: ReadonlySet<number>) => {
  try {
    setLocalStorageItemAsJSON(LocalStorageKey.SOUNDBOARD_FAVOURITES, [...ids]);
  } catch {
    // Storage full or blocked — favourites just do not persist.
  }
};

/**
 * Whether this client plays a clip it was told about: not while the
 * user deafened themselves, and never while a moderator deafened them
 * — the soundboard is call audio and follows the same switch.
 */
export const shouldPlayTriggeredSound = (
  ownState: Pick<TVoiceUserState, 'soundMuted' | 'serverDeafened'>
): boolean => !ownState.soundMuted && !ownState.serverDeafened;

/** The element volume for a clip: its own level (0–100) scaled by the user's slider (0–100). */
export const soundElementVolume = (clipVolume: number, userVolume: number): number => {
  const clip = Math.min(100, Math.max(0, clipVolume)) / 100;
  const user = Math.min(100, Math.max(0, userVolume)) / 100;
  return Math.min(1, clip * user);
};

/** How long the ripple stays on the player's tile after a trigger. */
export const SOUND_RIPPLE_MS = 1_600;
