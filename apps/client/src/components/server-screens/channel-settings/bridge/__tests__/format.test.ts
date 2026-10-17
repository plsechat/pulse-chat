import { describe, expect, test } from 'bun:test';
import {
  describeDirectionInheritance,
  describeServerLinkState,
  DIRECTION_OPTIONS,
  directionLabel,
  remoteChannelLabel,
  summarizeConnection,
  whyNotBridgeable
} from '../format';

describe('bridge tab copy', () => {
  test('the three directions each have a label and a sentence; labels resolve by value', () => {
    expect(DIRECTION_OPTIONS.map((o) => o.value)).toEqual(['both', 'inbound', 'outbound']);
    for (const option of DIRECTION_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.endsWith('.')).toBe(true);
    }
    expect(directionLabel('inbound')).toBe('Only from there');
  });

  test('the connection line names the next step for every state', () => {
    const base = { available: true, configured: true, connected: false, botUser: null, lastError: null };

    expect(summarizeConnection({ ...base, available: false })).toEqual({
      tone: 'muted',
      text: 'The bridge plugin is not running.'
    });
    expect(summarizeConnection({ ...base, configured: false }).tone).toBe('warn');
    expect(summarizeConnection({ ...base, configured: false }).text).toContain('Instance → Plugins');
    expect(summarizeConnection({ ...base, connected: true, botUser: { id: '1', name: 'pulse-bridge' } })).toEqual({
      tone: 'ok',
      text: 'Connected as pulse-bridge.'
    });
    expect(summarizeConnection({ ...base, lastError: 'The bot token was rejected' })).toEqual({
      tone: 'warn',
      text: 'Not connected: The bot token was rejected'
    });
    expect(summarizeConnection(base).text).toBe('Connecting…');
  });

  test('remote channels are named when the listing knows them, else shown by id', () => {
    const channels = [{ id: '2', guildId: '1', name: 'general', parentName: null, position: 0 }];
    expect(remoteChannelLabel(channels, '2')).toBe('#general');
    expect(remoteChannelLabel(channels, '3')).toBe('channel 3');
  });

  test('the refusal reasons match the server wording', () => {
    expect(whyNotBridgeable({ e2ee: true, type: 'TEXT' })).toContain('end-to-end encrypted');
    expect(whyNotBridgeable({ e2ee: false, type: 'VOICE' })).toContain('Only text channels');
  });

  test('the server-link line names the state the channel is in', () => {
    const serverLink = {
      id: 1,
      remoteGuildId: '1',
      remoteGuildName: 'Night Raiders',
      mode: 'match' as const,
      defaultDirection: 'both' as const
    };
    const link = {
      id: 5,
      channelId: 10,
      remoteGuildId: '1',
      remoteChannelId: '2',
      webhookId: '9',
      serverLinkId: 1,
      excluded: false,
      direction: 'both' as const,
      createdBy: 1,
      createdAt: 0
    };

    expect(describeServerLinkState({ link: null, serverLink: null })).toEqual({ kind: 'none' });
    expect(describeServerLinkState({ link, serverLink })).toEqual({
      kind: 'paired',
      text: 'Bridged with the server link to Night Raiders.'
    });
    expect(describeServerLinkState({ link: { ...link, excluded: true, webhookId: null }, serverLink }).kind).toBe('excluded');
    expect(describeServerLinkState({ link: { ...link, serverLinkId: null }, serverLink })).toMatchObject({ kind: 'manual' });
    expect(describeServerLinkState({ link: null, serverLink })).toEqual({
      kind: 'unpaired',
      text: 'Not paired yet. The next sync pairs it with a channel of the same name in Night Raiders.'
    });
    expect(
      describeServerLinkState({ link: null, serverLink: { ...serverLink, mode: 'mirror', remoteGuildName: null } })
    ).toMatchObject({ kind: 'unpaired', text: expect.stringContaining('or creates one there') });
    expect(describeServerLinkState({ link: null, serverLink: { ...serverLink, remoteGuildName: null } })).toMatchObject({
      kind: 'unpaired',
      text: expect.stringContaining('the remote server')
    });
  });

  test('direction inheritance is stated against the server default', () => {
    expect(describeDirectionInheritance('both', 'both')).toBe('Inherits the server default (both ways).');
    expect(describeDirectionInheritance('inbound', 'both')).toBe('Overrides the server default (both ways).');
  });
});
