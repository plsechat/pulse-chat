/**
 * Grid helpers behind the soundboard popover: favourites first, search,
 * the starred set round-trip, and the local play rules.
 *
 * Run via:
 *   bun test apps/client/src/features/server/sounds/__tests__/soundboard.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  filterSounds,
  loadFavouriteSoundIds,
  saveFavouriteSoundIds,
  shouldPlayTriggeredSound,
  sortSounds,
  soundElementVolume,
  toggleFavourite
} from '../soundboard';

const sounds = [
  { id: 1, name: 'Zap', emoji: '⚡', volume: 100 },
  { id: 2, name: 'airhorn', emoji: '📯', volume: 80 },
  { id: 3, name: 'Boo', emoji: null, volume: 50 },
  { id: 4, name: 'crickets', emoji: '🦗', volume: 100 }
];

describe('sortSounds', () => {
  test('favourites come first, each group alphabetical ignoring case', () => {
    expect(sortSounds(sounds, new Set([4, 1])).map((s) => s.name)).toEqual([
      'crickets',
      'Zap',
      'airhorn',
      'Boo'
    ]);
    expect(sortSounds(sounds, new Set()).map((s) => s.name)).toEqual([
      'airhorn',
      'Boo',
      'crickets',
      'Zap'
    ]);
  });

  test('does not mutate the input', () => {
    const copy = [...sounds];
    sortSounds(sounds, new Set([3]));
    expect(sounds).toEqual(copy);
  });
});

describe('filterSounds', () => {
  test('matches name substrings case-insensitively and emoji; blank keeps all', () => {
    expect(filterSounds(sounds, 'OO').map((s) => s.id)).toEqual([3]);
    expect(filterSounds(sounds, 'r').map((s) => s.id)).toEqual([2, 4]);
    expect(filterSounds(sounds, '📯').map((s) => s.id)).toEqual([2]);
    expect(filterSounds(sounds, '   ')).toHaveLength(4);
    expect(filterSounds(sounds, 'nothing')).toHaveLength(0);
  });
});

describe('favourites', () => {
  test('toggle adds and removes without touching the original set', () => {
    const base = new Set([1]);
    const added = toggleFavourite(base, 2);
    expect([...added]).toEqual([1, 2]);
    expect([...base]).toEqual([1]);
    expect([...toggleFavourite(added, 1)]).toEqual([2]);
  });

  test('round-trips through localStorage and ignores junk', () => {
    localStorage.removeItem('pulse-soundboard-favourites');
    expect(loadFavouriteSoundIds().size).toBe(0);

    saveFavouriteSoundIds(new Set([5, 9]));
    expect([...loadFavouriteSoundIds()]).toEqual([5, 9]);

    localStorage.setItem('pulse-soundboard-favourites', JSON.stringify([1, 'x', 2.5, null, 7]));
    expect([...loadFavouriteSoundIds()]).toEqual([1, 7]);

    localStorage.setItem('pulse-soundboard-favourites', '{not json');
    expect(loadFavouriteSoundIds().size).toBe(0);
    localStorage.removeItem('pulse-soundboard-favourites');
  });
});

describe('play rules', () => {
  test('a deafened user (self or moderator) hears nothing', () => {
    expect(shouldPlayTriggeredSound({ soundMuted: false, serverDeafened: false })).toBe(true);
    expect(shouldPlayTriggeredSound({ soundMuted: true, serverDeafened: false })).toBe(false);
    expect(shouldPlayTriggeredSound({ soundMuted: false, serverDeafened: true })).toBe(false);
  });

  test('element volume is the clip level scaled by the user level, clamped', () => {
    expect(soundElementVolume(100, 100)).toBe(1);
    expect(soundElementVolume(50, 100)).toBe(0.5);
    expect(soundElementVolume(80, 50)).toBeCloseTo(0.4);
    expect(soundElementVolume(0, 100)).toBe(0);
    expect(soundElementVolume(250, 300)).toBe(1);
    expect(soundElementVolume(-5, 100)).toBe(0);
  });
});
