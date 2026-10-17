import { describe, expect, test } from 'bun:test';
import type { TSubcommandDefinition } from '@pulse/shared';
import {
  coerceCommandArgs,
  parseCommandArgs,
  resolveCommandInvocation
} from '../parse-command-args';

describe('parseCommandArgs', () => {
  test('returns undefined commandName and empty args for empty string', () => {
    expect(parseCommandArgs('')).toEqual({ commandName: undefined, args: [] });
  });

  test('returns undefined commandName and empty args for whitespace only', () => {
    expect(parseCommandArgs('   ')).toEqual({
      commandName: undefined,
      args: []
    });
  });

  test('returns commandName and empty args for command with no arguments', () => {
    expect(parseCommandArgs('/help')).toEqual({
      commandName: 'help',
      args: []
    });
  });

  test('returns commandName and empty args for command without slash and no arguments', () => {
    expect(parseCommandArgs('help')).toEqual({ commandName: 'help', args: [] });
  });

  test('returns commandName and single argument', () => {
    expect(parseCommandArgs('/ban user123')).toEqual({
      commandName: 'ban',
      args: ['user123']
    });
  });

  test('returns commandName and multiple arguments', () => {
    expect(parseCommandArgs('/kick user123 spamming')).toEqual({
      commandName: 'kick',
      args: ['user123', 'spamming']
    });
  });

  test('handles quoted arguments with spaces', () => {
    expect(parseCommandArgs('/ban user123 "reason with spaces"')).toEqual({
      commandName: 'ban',
      args: ['user123', 'reason with spaces']
    });
  });

  test('handles single quoted arguments', () => {
    expect(parseCommandArgs("/mute user123 'quiet please'")).toEqual({
      commandName: 'mute',
      args: ['user123', 'quiet please']
    });
  });

  test('handles command without leading slash', () => {
    expect(parseCommandArgs('ban user123 reason')).toEqual({
      commandName: 'ban',
      args: ['user123', 'reason']
    });
  });

  test('handles multiple spaces between arguments', () => {
    expect(parseCommandArgs('/kick   user123   reason')).toEqual({
      commandName: 'kick',
      args: ['user123', 'reason']
    });
  });

  test('handles mixed quoted and unquoted arguments', () => {
    expect(
      parseCommandArgs('/warn user123 "first reason" second "third reason"')
    ).toEqual({
      commandName: 'warn',
      args: ['user123', 'first reason', 'second', 'third reason']
    });
  });

  test('parses command with URL argument', () => {
    expect(
      parseCommandArgs('/play https://www.youtube.com/watch?v=abc123XYZ')
    ).toEqual({
      commandName: 'play',
      args: ['https://www.youtube.com/watch?v=abc123XYZ']
    });
  });
});

const subcommands: TSubcommandDefinition[] = [
  { name: 'play', args: [{ name: 'link', type: 'string' }] },
  { name: 'pause' },
  { name: 'seek', args: [{ name: 'seconds', type: 'number', required: true }] },
  { name: 'watching', hidden: true, args: [{ name: 'channelId', type: 'number' }] }
];
const parentArgs = [
  { name: 'url', type: 'string' as const },
  { name: 'action', type: 'string' as const }
];

describe('resolveCommandInvocation', () => {
  test('a command without sub-commands reads every token as its own arguments', () => {
    expect(resolveCommandInvocation({ args: parentArgs }, ['a', 'b', 'c'])).toEqual({
      argDefs: parentArgs,
      tokens: ['a', 'b', 'c'],
      usage: false
    });
    expect(resolveCommandInvocation({}, [])).toEqual({ argDefs: [], tokens: [], usage: false });
  });

  test('the first token names a sub-command; its arguments follow', () => {
    expect(resolveCommandInvocation({ subcommands }, ['seek', '90'])).toEqual({
      subcommand: subcommands[2],
      argDefs: subcommands[2]!.args!,
      tokens: ['90'],
      usage: false
    });
    expect(resolveCommandInvocation({ subcommands }, ['pause'])).toEqual({
      subcommand: subcommands[1],
      argDefs: [],
      tokens: [],
      usage: false
    });
    // Case does not matter for the verb; a hidden one is still callable.
    expect(resolveCommandInvocation({ subcommands }, ['Watching', '12']).subcommand?.name).toBe(
      'watching'
    );
  });

  test('a token that names no sub-command falls back to the parent arguments', () => {
    const resolved = resolveCommandInvocation(
      { args: parentArgs, subcommands },
      ['https://cdn.example.com/a.mp4']
    );
    expect(resolved).toEqual({
      argDefs: parentArgs,
      tokens: ['https://cdn.example.com/a.mp4'],
      usage: false
    });
  });

  test('a command that only has sub-commands is answered with usage when none is named', () => {
    expect(resolveCommandInvocation({ subcommands }, [])).toEqual({
      argDefs: [],
      tokens: [],
      usage: true
    });
    expect(resolveCommandInvocation({ subcommands }, ['rewind'])).toMatchObject({ usage: true });
    // An empty parent declaration counts as none.
    expect(resolveCommandInvocation({ args: [], subcommands }, ['rewind'])).toMatchObject({
      usage: true
    });
  });
});

describe('coerceCommandArgs', () => {
  test('reads each token with its declared type and drops the surplus', () => {
    expect(
      coerceCommandArgs(
        [
          { name: 'who', type: 'string' },
          { name: 'times', type: 'number' },
          { name: 'loud', type: 'boolean' }
        ],
        ['Alice', '3', 'true', 'extra']
      )
    ).toEqual({ who: 'Alice', times: 3, loud: true });
  });

  test('arguments nobody typed are absent, not undefined keys', () => {
    expect(coerceCommandArgs([{ name: 'who', type: 'string' }], [])).toEqual({});
    expect(coerceCommandArgs([{ name: 'loud', type: 'boolean' }], ['yes'])).toEqual({ loud: false });
  });
});
