import { describe, expect, test } from 'bun:test';
import {
  normalizeChannelName,
  planServerBridge,
  type TExistingPair,
  type TLocalCandidate,
  type TRemoteCandidate
} from '../servers/bridge-pairing';

/**
 * The pure half of the whole-server sync: who pairs with whom, what is
 * created on which side under each mode, what is skipped and why. No
 * database, no plugin.
 */

/** Same vectors as packages/plugins/discord-bridge/src/__tests__/pairing.test.ts. */
const NORMALISATION_VECTORS: [string, string][] = [
  ['General Chat', 'general-chat'],
  ['general-chat', 'general-chat'],
  ['  Raids!! ', 'raids'],
  ['Café_Lounge', 'cafe-lounge'],
  ['off--topic', 'off-topic'],
  ['#news', 'news'],
  ['🎮 games', 'games'],
  ['___', ''],
  ['Ünïcödé Ñame', 'unicode-name']
];

const local = (id: number, name: string, extra: Partial<TLocalCandidate> = {}): TLocalCandidate => ({
  id,
  name,
  type: 'TEXT',
  e2ee: false,
  private: false,
  categoryName: 'Chat',
  ...extra
});

const remote = (id: string, name: string, position: number, parentName: string | null = 'Chat'): TRemoteCandidate => ({
  id,
  name,
  parentName,
  position
});

const pair = (id: number, channelId: number, remoteChannelId: string, extra: Partial<TExistingPair> = {}): TExistingPair => ({
  id,
  channelId,
  remoteChannelId,
  excluded: false,
  serverLinkId: 1,
  live: true,
  ...extra
});

const plan = (input: Partial<Parameters<typeof planServerBridge>[0]>) =>
  planServerBridge({
    local: [],
    remote: [],
    existing: [],
    mode: 'match',
    createMissing: 'none',
    limit: 500,
    ...input
  });

describe('channel name normalisation (server copy)', () => {
  test('matches the plugin vectors', () => {
    for (const [input, expected] of NORMALISATION_VECTORS) {
      expect(normalizeChannelName(input)).toBe(expected);
    }
  });
});

describe('pairing by name', () => {
  test('same-name channels pair case- and punctuation-insensitively; the rest is reported, not created, in match mode', () => {
    const result = plan({
      local: [local(1, 'General Chat'), local(2, 'raids'), local(3, 'lonely')],
      remote: [remote('r1', 'general-chat', 1), remote('r2', 'Raids', 2), remote('r3', 'news', 3)]
    });

    expect(result.pair).toEqual([
      { localId: 1, localName: 'General Chat', remoteId: 'r1', remoteName: 'general-chat' },
      { localId: 2, localName: 'raids', remoteId: 'r2', remoteName: 'Raids' }
    ]);
    expect(result.createHere).toEqual([]);
    expect(result.createThere).toEqual([]);
    expect(result.skipped).toEqual([
      { name: 'lonely', side: 'here', reason: 'no channel of that name over there' },
      { name: 'news', side: 'there', reason: 'no channel of that name here' }
    ]);
  });

  test('existing pairs, hand-made links and excluded rows take their channels out of the running', () => {
    const result = plan({
      mode: 'mirror',
      createMissing: 'both',
      local: [local(1, 'general'), local(2, 'raids'), local(3, 'mods'), local(4, 'quiet')],
      remote: [remote('r1', 'general', 1), remote('r2', 'raids', 2), remote('r3', 'mods', 3), remote('r5', 'fresh', 5)],
      existing: [
        pair(10, 1, 'r1'),
        // Linked by hand to a different remote channel: both ids are taken.
        pair(11, 2, 'r9', { serverLinkId: null }),
        // Excluded pair: neither side gets a twin.
        pair(12, 3, 'r3', { excluded: true, live: false }),
        // Excluded before it ever paired: the placeholder blocks the local side only.
        pair(13, 4, 'excluded:4', { excluded: true, live: false })
      ]
    });

    expect(result.pair).toEqual([]);
    expect(result.createHere).toEqual([
      { remoteId: 'r2', name: 'raids', categoryName: 'Chat' },
      { remoteId: 'r5', name: 'fresh', categoryName: 'Chat' }
    ]);
    expect(result.createThere).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  test('a live server-linked pair whose remote channel vanished is stale; excluded and hand-made rows are not', () => {
    const result = plan({
      local: [local(1, 'a'), local(2, 'b'), local(3, 'c')],
      remote: [],
      existing: [pair(10, 1, 'gone'), pair(11, 2, 'gone-too', { serverLinkId: null }), pair(12, 3, 'r3', { excluded: true, live: false })]
    });

    expect(result.stale.map((row) => row.id)).toEqual([10]);
  });

  test('duplicate names on a side: the first (by position / order) is used, the second reported', () => {
    const result = plan({
      local: [local(1, 'general'), local(2, 'General')],
      remote: [remote('r2', 'GENERAL', 2), remote('r1', 'general', 1)]
    });

    expect(result.pair).toEqual([{ localId: 1, localName: 'general', remoteId: 'r1', remoteName: 'general' }]);
    expect(result.skipped).toEqual([
      { name: 'GENERAL', side: 'there', reason: 'another channel there is already called "general"' },
      { name: 'General', side: 'here', reason: 'another channel here is already called "general"' }
    ]);
  });
});

describe('skip rules', () => {
  test('voice, forum, thread, encrypted and private channels here are left alone with a reason; the remote listing\'s own skips are relayed', () => {
    const result = plan({
      mode: 'mirror',
      createMissing: 'both',
      local: [
        local(1, 'Voice', { type: 'VOICE' }),
        local(2, 'forum', { type: 'FORUM' }),
        local(3, 'thread', { type: 'THREAD' }),
        local(4, 'secret', { e2ee: true }),
        local(5, 'mods', { private: true }),
        local(6, '!!!')
      ],
      remoteSkipped: [{ name: 'Lounge', reason: 'voice channel' }]
    });

    expect(result.createThere).toEqual([]);
    expect(result.skipped.map((s) => [s.name, s.side, s.reason])).toEqual([
      ['Lounge', 'there', 'voice channel'],
      ['Voice', 'here', 'voice channel'],
      ['forum', 'here', 'forum'],
      ['thread', 'here', 'thread (follows its parent)'],
      ['secret', 'here', 'end-to-end encrypted'],
      ['mods', 'here', 'private channel (link it from its own Bridge tab if you mean to)'],
      ['!!!', 'here', 'name has no letters or digits']
    ]);
  });

  test('the per-sync limit bounds what is considered; the overflow is reported', () => {
    const result = plan({
      limit: 2,
      local: [local(1, 'a'), local(2, 'b'), local(3, 'c')],
      remote: [remote('r1', 'a', 1), remote('r2', 'b', 2), remote('r3', 'c', 3)]
    });

    expect(result.pair.map((p) => p.localId)).toEqual([1, 2]);
    expect(result.skipped).toEqual([{ name: 'c', side: 'here', reason: 'beyond the 2-channel limit of one sync' }]);
  });
});

describe('mode matrix', () => {
  const inputs = {
    local: [local(1, 'shared'), local(2, 'only-here', { categoryName: 'Staff' })],
    remote: [remote('r1', 'shared', 1), remote('r2', 'only-there', 2, 'Events')]
  };

  test.each([
    ['match', 'none', [], []],
    ['match', 'both', [], []],
    ['mirror', 'none', [], []],
    ['mirror', 'here', ['only-there'], []],
    ['mirror', 'there', [], ['only-here']],
    ['mirror', 'both', ['only-there'], ['only-here']]
  ] as const)('%s / createMissing=%s', (mode, createMissing, here, there) => {
    const result = plan({ ...inputs, mode, createMissing });

    expect(result.pair).toHaveLength(1);
    expect(result.createHere.map((c) => c.name)).toEqual([...here]);
    expect(result.createThere.map((c) => c.name)).toEqual([...there]);
    if (here.length > 0) expect(result.createHere[0]!.categoryName).toBe('Events');
    if (there.length > 0) expect(result.createThere[0]!.categoryName).toBe('Staff');

    const reported = result.skipped.map((s) => s.name);
    expect(reported.includes('only-here')).toBe(there.length === 0);
    expect(reported.includes('only-there')).toBe(here.length === 0);
  });
});
