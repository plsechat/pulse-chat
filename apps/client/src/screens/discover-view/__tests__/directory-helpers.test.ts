import { describe, expect, test } from 'bun:test';
import type { TDirectoryEntry } from '@pulse/server/types';
import {
  directoryEntryKey,
  directoryLogoSrc,
  formatDirectoryCounts,
  formatFetchedAgo,
  isInvalidPasswordError,
  parseTagsInput,
  validateDirectoryCard
} from '../directory-helpers';

const entry = (over: Partial<TDirectoryEntry>): TDirectoryEntry => ({
  source: 'local',
  serverId: 1,
  publicId: 'pid',
  name: 'Club',
  description: null,
  tags: [],
  game: null,
  memberCount: 0,
  onlineCount: 0,
  logo: null,
  hasPassword: false,
  joined: false,
  instance: null,
  fetchedAt: null,
  ...over
});

describe('directory helpers', () => {
  test('keys stay distinct for the same publicId on two instances', () => {
    const local = entry({});
    const remote = entry({
      source: 'federated',
      serverId: null,
      instance: { id: 2, domain: 'peer.example', name: 'Peer' }
    });
    expect(directoryEntryKey(local)).not.toBe(directoryEntryKey(remote));
    expect(directoryEntryKey(remote)).toContain('peer.example');
  });

  test('a local logo resolves on the home instance; a federated one is used as sent', () => {
    expect(directoryLogoSrc({ source: 'local', logo: null })).toBe('');
    expect(directoryLogoSrc({ source: 'local', logo: 'club.png' })).toMatch(/\/public\/club\.png$/);
    expect(
      directoryLogoSrc({ source: 'federated', logo: 'https://peer.example/public/x.png' })
    ).toBe('https://peer.example/public/x.png');
  });

  test('counts read as a sentence', () => {
    expect(formatDirectoryCounts(1, 0)).toBe('1 member · 0 online');
    expect(formatDirectoryCounts(1200, 34)).toBe('1,200 members · 34 online');
  });

  test('staleness is shown from one hour, in hours then days', () => {
    const now = Date.UTC(2026, 9, 16, 12);
    const h = 60 * 60 * 1000;
    expect(formatFetchedAgo(now - 30 * 60 * 1000, now)).toBeNull();
    expect(formatFetchedAgo(now - 3 * h, now)).toBe('updated 3 h ago');
    expect(formatFetchedAgo(now - 25 * h, now)).toBe('updated 1 day ago');
    expect(formatFetchedAgo(now - 72 * h, now)).toBe('updated 3 days ago');
    expect(formatFetchedAgo(now + h, now)).toBeNull();
  });

  test('tags are split, trimmed, deduplicated case-insensitively and capped at five', () => {
    expect(parseTagsInput('')).toEqual([]);
    expect(parseTagsInput(' casual, Ranked ,casual\nranked, , pvp')).toEqual([
      'casual',
      'Ranked',
      'pvp'
    ]);
    expect(parseTagsInput('a,b,c,d,e,f,g')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('the card form mirrors the route bounds', () => {
    const ok = validateDirectoryCard({
      listed: true,
      description: 'x'.repeat(300),
      tagsText: 'a, b, c, d, e',
      game: 'g'.repeat(60),
      discoverable: true,
      allowNewUsers: true
    });
    expect(ok).toEqual({});

    const bad = validateDirectoryCard({
      listed: true,
      description: 'x'.repeat(301),
      tagsText: 'a, b, c, d, e, f',
      game: 'g'.repeat(61),
      discoverable: false,
      allowNewUsers: true
    });
    expect(Object.keys(bad).sort()).toEqual([
      'directoryDescription',
      'directoryGame',
      'directoryListed',
      'directoryTags'
    ]);

    expect(
      validateDirectoryCard({
        listed: false,
        description: '',
        tagsText: 'x'.repeat(25),
        game: '',
        discoverable: false,
        allowNewUsers: false
      })
    ).toEqual({ directoryTags: 'Each tag can be up to 24 characters' });
  });

  test('recognises the join routes\' password refusal only', () => {
    expect(isInvalidPasswordError(new Error('Invalid password'))).toBe(true);
    expect(isInvalidPasswordError(new Error('Too many failed attempts'))).toBe(false);
    expect(isInvalidPasswordError('Invalid password')).toBe(false);
  });
});
