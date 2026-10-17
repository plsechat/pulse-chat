import { ChannelType, Permission } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import type { TDiscordChannel, TDiscordMember, TDiscordRole } from '../discord/types';
import {
  boundText,
  canReadHistory,
  colorIntToHex,
  computeChannelPermissions,
  DISCORD_PERMISSION_TABLE,
  IMPORT_BOT_PERMISSION_BITS,
  mapChannelType,
  mapMessageContent,
  mapPermissionBits,
  memberDisplayName,
  snowflakeMinusOne,
  snowflakeToTimestamp,
  timestampToSnowflake,
  userAvatarUrl
} from '../mapping';

/**
 * The pure mapping layer: the documented permission table, the
 * readability computation, channel kinds, colours, snowflake
 * arithmetic and the message rewrite. No database, no network.
 */

describe('permission table', () => {
  test('every documented bit grants exactly what the table says', () => {
    for (const entry of DISCORD_PERMISSION_TABLE) {
      expect(mapPermissionBits(entry.bit.toString())).toEqual(
        Object.values(Permission).filter((p) => entry.grants.includes(p))
      );
    }
  });

  test('ADMINISTRATOR grants every permission we have', () => {
    expect(mapPermissionBits((1n << 3n).toString())).toEqual(Object.values(Permission));
  });

  test('bits without a counterpart grant nothing; combinations union', () => {
    expect(mapPermissionBits((1n << 7n).toString())).toEqual([]); // VIEW_AUDIT_LOG
    expect(mapPermissionBits('0')).toEqual([]);
    expect(mapPermissionBits('not-a-number')).toEqual([]);
    const combined = mapPermissionBits(((1n << 13n) | (1n << 15n)).toString());
    expect(combined).toEqual(
      expect.arrayContaining([Permission.MANAGE_MESSAGES, Permission.PIN_MESSAGES, Permission.UPLOAD_FILES])
    );
    expect(combined).toHaveLength(3);
  });

  test('the install link asks for VIEW_CHANNEL + READ_MESSAGE_HISTORY only', () => {
    expect(IMPORT_BOT_PERMISSION_BITS).toBe((1n << 10n) | (1n << 16n));
  });
});

describe('computeChannelPermissions', () => {
  const guildId = '1';
  const roles: TDiscordRole[] = [
    { id: '1', name: '@everyone', color: 0, position: 0, permissions: ((1n << 10n) | (1n << 16n)).toString() },
    { id: '2', name: 'Bot', color: 0, position: 1, permissions: '0' }
  ];
  const bot: TDiscordMember = { user: { id: '9', username: 'bot' }, roles: ['2'] };

  test('a channel without overwrites inherits the role bits', () => {
    const channel: TDiscordChannel = { id: '5', type: 0, permission_overwrites: [] };
    expect(canReadHistory(computeChannelPermissions(guildId, roles, bot, '9', channel))).toBe(true);
  });

  test('an @everyone deny hides the channel; a role allow restores it; a member deny wins', () => {
    const denied: TDiscordChannel = {
      id: '5',
      type: 0,
      permission_overwrites: [{ id: '1', type: 0, allow: '0', deny: (1n << 10n).toString() }]
    };
    expect(canReadHistory(computeChannelPermissions(guildId, roles, bot, '9', denied))).toBe(false);

    const restored: TDiscordChannel = {
      ...denied,
      permission_overwrites: [
        ...denied.permission_overwrites!,
        { id: '2', type: 0, allow: (1n << 10n).toString(), deny: '0' }
      ]
    };
    expect(canReadHistory(computeChannelPermissions(guildId, roles, bot, '9', restored))).toBe(true);

    const memberDenied: TDiscordChannel = {
      ...restored,
      permission_overwrites: [
        ...restored.permission_overwrites!,
        { id: '9', type: 1, allow: '0', deny: (1n << 16n).toString() }
      ]
    };
    expect(canReadHistory(computeChannelPermissions(guildId, roles, bot, '9', memberDenied))).toBe(false);
  });

  test('ADMINISTRATOR ignores overwrites', () => {
    const admin: TDiscordRole[] = [roles[0]!, { ...roles[1]!, permissions: (1n << 3n).toString() }];
    const denied: TDiscordChannel = {
      id: '5',
      type: 0,
      permission_overwrites: [{ id: '1', type: 0, allow: '0', deny: (1n << 10n).toString() }]
    };
    expect(canReadHistory(computeChannelPermissions(guildId, admin, bot, '9', denied))).toBe(true);
  });
});

describe('channel kinds, colours, names', () => {
  test('text and announcement → TEXT, voice and stage → VOICE, forum and media → FORUM, rest → null', () => {
    expect(mapChannelType(0)).toBe(ChannelType.TEXT);
    expect(mapChannelType(5)).toBe(ChannelType.TEXT);
    expect(mapChannelType(2)).toBe(ChannelType.VOICE);
    expect(mapChannelType(13)).toBe(ChannelType.VOICE);
    expect(mapChannelType(15)).toBe(ChannelType.FORUM);
    expect(mapChannelType(16)).toBe(ChannelType.FORUM);
    expect(mapChannelType(4)).toBeNull();
    expect(mapChannelType(99)).toBeNull();
  });

  test('colour 0 is our default white; others are 6-digit hex', () => {
    expect(colorIntToHex(0)).toBe('#ffffff');
    expect(colorIntToHex(undefined)).toBe('#ffffff');
    expect(colorIntToHex(16711680)).toBe('#ff0000');
    expect(colorIntToHex(255)).toBe('#0000ff');
    expect(colorIntToHex(0x1000000)).toBe('#ffffff');
  });

  test('boundText trims, collapses line breaks, bounds by code point and falls back', () => {
    expect(boundText('  hello\nworld  ', 100)).toBe('hello world');
    expect(boundText('a'.repeat(50), 24)).toHaveLength(24);
    expect(boundText('', 24, 'x')).toBe('x');
    expect(boundText('😀'.repeat(30), 24)).toHaveLength(48); // 24 code points, 2 units each
  });

  test('display name prefers nick, then global name, then username', () => {
    const user = { username: 'bob', global_name: 'Bobby G' };
    expect(memberDisplayName(user, 'Bob the Builder')).toBe('Bob the Builder');
    expect(memberDisplayName(user, null)).toBe('Bobby G');
    expect(memberDisplayName({ username: 'bob' }, null)).toBe('bob');
  });

  test('avatar URLs are built only from well-formed hashes, on the CDN host', () => {
    expect(userAvatarUrl('1', 'abc')).toBe('https://cdn.discordapp.com/avatars/1/abc.png?size=128');
    expect(userAvatarUrl('1', 'a_abc')).toBe('https://cdn.discordapp.com/avatars/1/a_abc.gif?size=128');
    expect(userAvatarUrl('1', '../x')).toBeNull();
    expect(userAvatarUrl('1', null)).toBeNull();
  });
});

describe('snowflakes', () => {
  test('timestamp ↔ snowflake round-trips to the millisecond', () => {
    const ts = Date.UTC(2024, 0, 15, 12, 30, 0);
    expect(snowflakeToTimestamp(timestampToSnowflake(ts))).toBe(ts);
    expect(snowflakeToTimestamp('not-an-id')).toBe(0);
    expect(snowflakeMinusOne('10')).toBe('9');
    expect(snowflakeMinusOne('0')).toBe('0');
  });
});

describe('mapMessageContent', () => {
  const lookup = {
    userId: (id: string) => (id === '100' ? 7 : undefined),
    roleId: (id: string) => (id === '200' ? 3 : undefined),
    emoji: (id: string) => (id === '300' ? { id: 11, name: 'pog' } : undefined),
    channelName: (id: string) => (id === '400' ? 'news' : undefined),
    roleName: (id: string) => (id === '201' ? 'Guests' : undefined)
  };

  test('mapped mentions become our tokens; unmapped degrade to readable text', () => {
    const content = mapMessageContent(
      {
        id: '1',
        type: 0,
        content: '<@100> <@!101> <@&200> <@&201> <@&202> <#400> <#401>',
        author: { id: '100', username: 'a' },
        timestamp: '2024-01-01T00:00:00Z',
        mentions: [{ id: '101', username: 'bobby', global_name: 'Bob' }]
      },
      lookup
    );
    expect(content).toBe('<@7> @Bob <@&3> @Guests @role #news #channel');
  });

  test('custom emoji, timestamps, @here, embeds and stickers', () => {
    const content = mapMessageContent(
      {
        id: '1',
        type: 0,
        content: 'gg <:pog:300> <a:dance:301> <t:1700000000:F> @here',
        author: { id: '100', username: 'a' },
        timestamp: '2024-01-01T00:00:00Z',
        embeds: [
          { title: 'Patch notes', url: 'https://example.com/notes' },
          { url: 'https://example.com/plain' },
          { title: 'no url' }
        ],
        sticker_items: [{ id: '1', name: 'wave' }]
      },
      lookup
    );
    expect(content).toBe(
      'gg <:pog:11> :dance: 2023-11-14 22:13 @everyone\nPatch notes — https://example.com/notes\nhttps://example.com/plain\n:wave:'
    );
  });

  test('an embed whose url is already in the text is not repeated; the body is bounded', () => {
    const content = mapMessageContent(
      {
        id: '1',
        type: 0,
        content: `see https://example.com/notes ${'x'.repeat(20_000)}`,
        author: { id: '100', username: 'a' },
        timestamp: '2024-01-01T00:00:00Z',
        embeds: [{ title: 'Patch notes', url: 'https://example.com/notes' }]
      },
      lookup
    );
    expect(content.startsWith('see https://example.com/notes')).toBe(true);
    expect(content).toHaveLength(16_000);
    expect(content.includes('Patch notes —')).toBe(false);
  });
});
