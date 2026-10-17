import { describe, expect, test } from 'bun:test';
import {
  avatarUrlOf,
  displayNameOf,
  htmlToText,
  mapInboundContent,
  mapInboundEmoji,
  mapOutboundContent,
  mapOutboundEmoji,
  MAX_LOCAL_CONTENT,
  MAX_REMOTE_CONTENT,
  quoteLine
} from '../mapping';
import gateway from './fixtures/gateway.json';

const lookup = {
  roleName: (id: string) => (id === '300000000000000002' ? 'Officers' : undefined),
  channelName: (id: string) => (id === '200000000000000002' ? 'raids' : undefined)
};

describe('inbound content', () => {
  test('mentions, channels, custom emoji, roles, timestamps, embeds and stickers follow the import rules', () => {
    const content = mapInboundContent(gateway.messageCreate.d, lookup);

    expect(content).toBe(
      'hey @Dave see #raids :pogchamp: @Officers at 2025-10-09 08:53 @here\nA link — https://example.org/post\n:wave:'
    );
  });

  test('unknown mentions degrade to generic words and @here is NOT promoted to an everyone-ping', () => {
    const content = mapInboundContent(
      {
        id: '1',
        channel_id: '2',
        content: '<@1> <@&2> <#3> @here @everyone',
        mentions: []
      },
      { roleName: () => undefined, channelName: () => undefined }
    );

    expect(content).toBe('@someone @role #channel @here @everyone');
  });

  test('an embed whose url is already in the text is not repeated; content is capped', () => {
    const content = mapInboundContent(
      {
        id: '1',
        channel_id: '2',
        content: `see https://example.org ${'x'.repeat(MAX_LOCAL_CONTENT)}`,
        embeds: [{ url: 'https://example.org', title: 'dup' }]
      },
      lookup
    );

    expect(content.includes('dup')).toBe(false);
    expect(Array.from(content).length).toBe(MAX_LOCAL_CONTENT);
  });

  test('display name prefers the server nickname, then the global name, then the username', () => {
    const user = { id: '1', username: 'carol', global_name: 'Carol' };
    expect(displayNameOf(user, { nick: 'Caz' })).toBe('Caz');
    expect(displayNameOf(user, { nick: null })).toBe('Carol');
    expect(displayNameOf({ id: '1', username: 'carol' })).toBe('carol');
    expect(displayNameOf({ id: '1', username: '' })).toBe('Someone');
  });

  test('avatar urls are built only from well-formed hashes; animated ones are gifs', () => {
    expect(avatarUrlOf({ id: '5', username: 'u', avatar: 'a_abc' })).toBe(
      'https://cdn.discordapp.com/avatars/5/a_abc.gif?size=128'
    );
    expect(avatarUrlOf({ id: '5', username: 'u', avatar: 'abc' }, { avatar: 'srv' }, '9')).toBe(
      'https://cdn.discordapp.com/guilds/9/users/5/avatars/srv.png?size=128'
    );
    expect(avatarUrlOf({ id: '5', username: 'u', avatar: '../x' })).toBeUndefined();
    expect(avatarUrlOf({ id: '5', username: 'u', avatar: null })).toBeUndefined();
  });

  test('reaction emoji: unicode as is, custom as our :name: token, nameless ignored', () => {
    expect(mapInboundEmoji({ id: null, name: '👍' })).toBe('👍');
    expect(mapInboundEmoji({ id: '4', name: 'pogchamp' })).toBe(':pogchamp:');
    expect(mapInboundEmoji({ id: '4', name: null })).toBeNull();
  });
});

describe('outbound content', () => {
  const out = {
    userName: (id: number) => (id === 8 ? 'Bob' : undefined),
    roleName: (id: number) => (id === 3 ? 'Raiders' : undefined)
  };

  test('composer HTML becomes text with line breaks, decoded entities and resolved tokens', () => {
    expect(
      mapOutboundContent('<p>Hello <@8> &amp; <@9> <:pogchamp:1></p><p>line &lt;2&gt;</p><ul><li>a</li><li>b</li></ul>', out)
    ).toBe('Hello @Bob & @member :pogchamp:\nline <2>\n- a\n- b');
  });

  test('token-form content (no HTML) is mapped the same way; role tokens resolve', () => {
    expect(mapOutboundContent('ping <@&3> and <@&4>', out)).toBe('ping @Raiders and @role');
  });

  test('legacy mention spans keep their label text', () => {
    expect(
      htmlToText('<p>hi <span data-mention-type="user" data-mention-id="8">@Bob</span></p>')
    ).toBe('hi @Bob\n');
  });

  test('content is capped at the remote limit with an ellipsis', () => {
    const mapped = mapOutboundContent('y'.repeat(MAX_REMOTE_CONTENT + 50), out);
    expect(Array.from(mapped).length).toBe(MAX_REMOTE_CONTENT);
    expect(mapped.endsWith('…')).toBe(true);
  });

  test('a reply quote carries the author and the first non-empty line, bounded', () => {
    expect(quoteLine('Ali', '\n\nfirst line here\nsecond')).toBe('> **Ali:** first line here');
    expect(quoteLine('Ali', 'z'.repeat(500)).length).toBeLessThan(140);
  });

  test('reaction emoji: unicode percent-encoded, custom resolved to name:id or dropped', () => {
    const ids = (name: string) => (name === 'pogchamp' ? '400' : undefined);
    expect(mapOutboundEmoji('👍', ids)).toBe('%F0%9F%91%8D');
    expect(mapOutboundEmoji(':pogchamp:', ids)).toBe('pogchamp:400');
    expect(mapOutboundEmoji(':nope:', ids)).toBeUndefined();
  });
});
