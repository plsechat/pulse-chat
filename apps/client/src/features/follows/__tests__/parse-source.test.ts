/**
 * The follow-address parser and the announcement-row recogniser.
 *
 * Run via: bun test apps/client/src/features/follows/__tests__/parse-source.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { parseAnnouncementRow } from '../announcement-rows';
import { formatFollowAddress, parseFollowAddress } from '../parse-source';

describe('parseFollowAddress', () => {
  test('domain/server/channel, scheme and whitespace tolerated, domain lower-cased', () => {
    expect(parseFollowAddress('  https://Peer.Example:4991/srv-1/chan-2/ ')).toEqual({
      domain: 'peer.example:4991',
      serverPublicId: 'srv-1',
      channelPublicId: 'chan-2'
    });
    expect(formatFollowAddress({ domain: 'a.b', serverPublicId: 's', channelPublicId: 'c' })).toBe('a.b/s/c');
  });

  test('refuses the wrong part count, bad hosts and oversized ids', () => {
    expect(parseFollowAddress('peer.example/only')).toBeNull();
    expect(parseFollowAddress('peer.example/a/b/c')).toBeNull();
    expect(parseFollowAddress('pe er.example/a/b')).toBeNull();
    expect(parseFollowAddress('peer.example:99999999/a/b')).toBeNull();
    expect(parseFollowAddress(`peer.example/${'x'.repeat(65)}/b`)).toBeNull();
    expect(parseFollowAddress(`${'d'.repeat(254)}/a/b`)).toBeNull();
    expect(parseFollowAddress('')).toBeNull();
  });
});

describe('parseAnnouncementRow', () => {
  const row = {
    kind: 'announcement' as const,
    sourceKey: 'local:1:2',
    source: { domain: null, serverPublicId: 's', serverName: 'Server', channelPublicId: 'c', channelName: 'news' },
    messageId: 2,
    content: 'hello',
    author: { publicId: 'p', name: 'Ann', avatarUrl: '/public/a.png' },
    edited: false
  };

  test('recognises the exact shape and defaults the optional bits', () => {
    expect(parseAnnouncementRow(JSON.stringify(row))).toEqual(row);
    const minimal = parseAnnouncementRow(
      JSON.stringify({ kind: 'announcement', sourceKey: 'k', content: 'c', source: { channelName: 'n', serverName: 's' }, author: { name: 'a' } })
    );
    expect(minimal).toMatchObject({ messageId: 0, edited: false, author: { avatarUrl: null, publicId: '' }, source: { domain: null } });
  });

  test('anything else is not an announcement row', () => {
    expect(parseAnnouncementRow(null)).toBeNull();
    expect(parseAnnouncementRow('identity_reset')).toBeNull();
    expect(parseAnnouncementRow('{"kind":"event","eventId":1}')).toBeNull();
    expect(parseAnnouncementRow('{"kind":"announcement"}')).toBeNull();
    expect(parseAnnouncementRow('{not json')).toBeNull();
  });
});
