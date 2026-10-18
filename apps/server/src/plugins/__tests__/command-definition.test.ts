import { describe, expect, test } from 'bun:test';
import type { CommandDefinition, TSubcommandDefinition } from '@pulse/shared';
import { assertCommandDefinition } from '../command-definition';

const command = (
  subcommands: TSubcommandDefinition[] | undefined
): CommandDefinition<unknown> => ({
  name: 'watch',
  subcommands,
  executes: async () => undefined
});

describe('assertCommandDefinition', () => {
  test('a plain command and a well-formed set of sub-commands pass', () => {
    expect(() => assertCommandDefinition(command(undefined))).not.toThrow();
    expect(() =>
      assertCommandDefinition(
        command([
          { name: 'play', args: [{ name: 'link', type: 'string', placeholder: 'A link' }] },
          { name: 'pause' },
          {
            name: 'mode',
            args: [
              {
                name: 'kind',
                type: 'string',
                choices: [{ value: 'fast' }, { value: 'slow', label: 'Slow' }]
              }
            ]
          },
          { name: 'watching', hidden: true, args: [{ name: 'channel-id', type: 'number' }] }
        ])
      )
    ).not.toThrow();
  });

  test('more than 20 sub-commands are refused', () => {
    const subs = Array.from({ length: 21 }, (_, i) => ({ name: `s${i}` }));
    expect(() => assertCommandDefinition(command(subs))).toThrow(
      'declares 21 sub-commands; at most 20'
    );
  });

  test('sub-command and argument names must be short lower-case identifiers', () => {
    expect(() => assertCommandDefinition(command([{ name: 'Pause' }]))).toThrow(
      "sub-command name 'Pause' must match"
    );
    expect(() => assertCommandDefinition(command([{ name: 'a'.repeat(33) }]))).toThrow(
      'must match'
    );
    expect(() =>
      assertCommandDefinition(
        command([{ name: 'seek', args: [{ name: 'Seconds', type: 'number' }] }])
      )
    ).toThrow("argument name 'Seconds' must match");
  });

  test('a sub-command declared twice is refused', () => {
    expect(() =>
      assertCommandDefinition(command([{ name: 'pause' }, { name: 'pause' }]))
    ).toThrow("declares sub-command 'pause' twice");
  });

  test('a sub-command takes at most 8 arguments, an argument at most 32 choices', () => {
    const args = Array.from({ length: 9 }, (_, i) => ({ name: `a${i}`, type: 'string' as const }));
    expect(() => assertCommandDefinition(command([{ name: 'many', args }]))).toThrow(
      'declares 9 arguments; at most 8'
    );
    const choices = Array.from({ length: 33 }, (_, i) => ({ value: `c${i}` }));
    expect(() =>
      assertCommandDefinition(
        command([{ name: 'pick', args: [{ name: 'one', type: 'string', choices }] }])
      )
    ).toThrow('offers 33 choices; at most 32');
    expect(() =>
      assertCommandDefinition(
        command([{ name: 'pick', args: [{ name: 'one', type: 'string', choices: [{ value: '' }] }] }])
      )
    ).toThrow('must be 1 to 64 characters');
  });
});
