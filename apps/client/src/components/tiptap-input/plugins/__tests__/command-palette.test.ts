import { describe, expect, test } from 'bun:test';
import type { TCommandInfo } from '@pulse/shared';
import {
  commandQueryFromText,
  paletteItemText,
  resolvePalette,
  resolveUsageHint,
  splitQuery,
  usageHintText
} from '../command-palette';

/**
 * The palette's pure reasoning against a fake command store: the
 * official watch command (sub-commands), a plain command with a
 * choice argument, and a plain one with free arguments.
 */

const watch: TCommandInfo = {
  pluginId: 'watch-together',
  name: 'watch',
  description: 'Watch a video together',
  logo: 'https://example.com/watch.png',
  args: [
    { name: 'url', type: 'string' },
    { name: 'action', type: 'string' }
  ],
  subcommands: [
    {
      name: 'play',
      description: 'Play a link, or resume',
      args: [{ name: 'link', type: 'string', placeholder: 'YouTube link, .mp4, .m3u8' }]
    },
    { name: 'pause', description: 'Pause for everyone' },
    {
      name: 'seek',
      description: 'Jump everyone to a position',
      args: [{ name: 'seconds', type: 'number', required: true, placeholder: '90' }]
    },
    { name: 'stop', description: 'End the watch' },
    { name: 'status', description: 'What is playing' }
  ]
};

const deploy: TCommandInfo = {
  pluginId: 'deployer',
  name: 'deploy',
  description: 'Ship a build',
  args: [
    {
      name: 'target',
      type: 'string',
      required: true,
      choices: [
        { value: 'prod', label: 'Production', description: 'The live site' },
        { value: 'stage' }
      ]
    },
    { name: 'note', type: 'string' }
  ]
};

const greet: TCommandInfo = {
  pluginId: 'greeter',
  name: 'greet',
  description: 'Greet someone',
  args: [{ name: 'who', type: 'string', required: true }]
};

const commands = [watch, deploy, greet];

const titles = (query: string) => resolvePalette(commands, query)?.items.map((i) => i.title);

describe('commandQueryFromText', () => {
  test('a slash at the start of the only line is a command; anything else is not', () => {
    expect(commandQueryFromText('/watch seek 9')).toBe('watch seek 9');
    expect(commandQueryFromText('/')).toBe('');
    expect(commandQueryFromText('hello /watch')).toBeNull();
    expect(commandQueryFromText('/watch\nmore')).toBeNull();
    expect(commandQueryFromText('')).toBeNull();
  });
});

describe('splitQuery', () => {
  test('splits on whitespace, keeps quoted runs together, notes a trailing space', () => {
    expect(splitQuery('watch seek 90')).toEqual({ tokens: ['watch', 'seek', '90'], trailingSpace: false });
    expect(splitQuery('watch ')).toEqual({ tokens: ['watch'], trailingSpace: true });
    expect(splitQuery('greet "Alice B')).toEqual({ tokens: ['greet', '"Alice B'], trailingSpace: false });
    expect(splitQuery('')).toEqual({ tokens: [], trailingSpace: false });
    expect(splitQuery('   ')).toEqual({ tokens: [], trailingSpace: false });
  });
});

describe('resolvePalette — level one', () => {
  test('an empty query lists every command with its signature, logo and insertion', () => {
    const palette = resolvePalette(commands, '');
    expect(palette).toMatchObject({ level: 'commands', heading: 'Commands' });
    expect(palette!.items.map((i) => i.kind)).toEqual(['command', 'command', 'command']);
    expect(palette!.items[0]).toMatchObject({
      title: '/watch',
      description: 'Watch a video together',
      signature: '/watch play | pause | seek | stop | status',
      insert: '/watch ',
      logo: 'https://example.com/watch.png'
    });
    expect(palette!.items[1]).toMatchObject({ signature: '/deploy <target> [note]', insert: '/deploy ' });
    expect(palette!.items[2]).toMatchObject({ signature: '/greet <who>' });
  });

  test('a partial name filters by name, plugin id and description; a prefix match comes first', () => {
    expect(titles('wa')).toEqual(['/watch']);
    expect(titles('gree')).toEqual(['/greet']);
    // "ship" is only in the description.
    expect(titles('ship')).toEqual(['/deploy']);
    expect(titles('zzz')).toBeUndefined();
    expect(resolvePalette([], '')).toBeNull();
  });

  test('an exactly typed name is still offered until the space is typed', () => {
    expect(titles('watch')).toEqual(['/watch']);
  });
});

describe('resolvePalette — sub-commands', () => {
  test('the space after a command with sub-commands opens its verbs', () => {
    const palette = resolvePalette(commands, 'watch ');
    expect(palette).toMatchObject({ level: 'subcommands', heading: '/watch' });
    expect(palette!.items.map((i) => i.title)).toEqual(['play', 'pause', 'seek', 'stop', 'status']);
    expect(palette!.items[0]).toMatchObject({
      kind: 'subcommand',
      signature: '/watch play [link]',
      description: 'Play a link, or resume',
      insert: '/watch play ',
      logo: 'https://example.com/watch.png'
    });
    expect(palette!.items[2]!.signature).toBe('/watch seek <seconds>');
    expect(palette!.items[1]!.id).toBe('command-option-watch-together-watch-pause');
  });

  test('a partial verb filters the verbs; an exact verb closes the list so Enter sends', () => {
    expect(titles('watch s')).toEqual(['seek', 'stop', 'status']);
    expect(titles('watch pa')).toEqual(['pause']);
    expect(titles('watch pause')).toBeUndefined();
    expect(titles('watch stop')).toBeUndefined();
    expect(titles('WATCH Pause')).toBeUndefined();
  });

  test("the verb's own argument without choices offers nothing", () => {
    expect(titles('watch seek ')).toBeUndefined();
    expect(titles('watch seek 9')).toBeUndefined();
    expect(titles('watch play https://you')).toBeUndefined();
  });

  test('a token that is no verb (the old positional link) offers nothing', () => {
    expect(titles('watch https://www.youtube.com/watch?v=abc')).toBeUndefined();
    expect(titles('watch https://cdn.example.com/a.mp4 ')).toBeUndefined();
  });

  test('a space after a command without sub-commands or choices offers nothing', () => {
    expect(titles('greet ')).toBeUndefined();
    expect(titles('greet Ali')).toBeUndefined();
    expect(titles('nope ')).toBeUndefined();
  });
});

describe('resolvePalette — choices', () => {
  test('an argument with choices lists them, filtered by value or label, and rebuilds the text', () => {
    const palette = resolvePalette(commands, 'deploy ');
    expect(palette).toMatchObject({ level: 'choices', heading: 'target' });
    expect(palette!.items.map((i) => i.title)).toEqual(['Production', 'stage']);
    expect(palette!.items[0]).toMatchObject({
      kind: 'choice',
      signature: 'prod',
      description: 'The live site',
      insert: '/deploy prod '
    });
    expect(palette!.items[1]).toMatchObject({ signature: undefined, insert: '/deploy stage ' });

    expect(titles('deploy pro')).toEqual(['Production']);
    expect(titles('deploy st')).toEqual(['stage']);
    // An exact value is complete.
    expect(titles('deploy prod')).toBeUndefined();
    // The next argument has no choices.
    expect(titles('deploy prod ')).toBeUndefined();
    expect(titles('deploy prod fix')).toBeUndefined();
  });

  test('choices on a sub-command argument come after the verb', () => {
    const withChoices: TCommandInfo = {
      ...watch,
      subcommands: [
        {
          name: 'quality',
          args: [
            { name: 'level', type: 'string', choices: [{ value: 'auto' }, { value: '720', label: '720p' }] },
            { name: 'why', type: 'string' }
          ]
        }
      ]
    };
    const palette = resolvePalette([withChoices], 'watch quality ');
    expect(palette).toMatchObject({ level: 'choices', heading: 'level' });
    expect(palette!.items.map((i) => i.insert)).toEqual(['/watch quality auto ', '/watch quality 720 ']);
    expect(resolvePalette([withChoices], 'watch quality 7')!.items.map((i) => i.title)).toEqual(['720p']);
    expect(resolvePalette([withChoices], 'watch quality 720 ')).toBeNull();
  });
});

describe('resolveUsageHint', () => {
  test('nothing while the command name is still being typed', () => {
    expect(resolveUsageHint(commands, '')).toBeNull();
    expect(resolveUsageHint(commands, 'wat')).toBeNull();
    expect(resolveUsageHint(commands, 'watch')).toBeNull();
    expect(resolveUsageHint(commands, 'nope ')).toBeNull();
  });

  test('a command with sub-commands shows its verbs until one is named', () => {
    expect(resolveUsageHint(commands, 'watch ')).toEqual({
      head: '/watch',
      slots: [{ label: 'play | pause | seek | stop | status', active: true }],
      description: 'Watch a video together'
    });
    // The old positional link is no verb either: the verbs are what to learn.
    expect(resolveUsageHint(commands, 'watch https://x.test/a.mp4')!.slots[0]!.label).toBe(
      'play | pause | seek | stop | status'
    );
  });

  test('a named verb shows its arguments with the one being typed marked', () => {
    expect(resolveUsageHint(commands, 'watch seek')).toEqual({
      head: '/watch seek',
      slots: [{ label: '<seconds>', active: false }],
      description: 'Jump everyone to a position'
    });
    expect(resolveUsageHint(commands, 'watch seek ')).toEqual({
      head: '/watch seek',
      slots: [{ label: '<90>', active: true }],
      description: 'Jump everyone to a position'
    });
    expect(resolveUsageHint(commands, 'watch seek 4')!.slots).toEqual([{ label: '<90>', active: true }]);
    expect(resolveUsageHint(commands, 'watch seek 45 ')!.slots).toEqual([{ label: '<seconds>', active: false }]);
    expect(resolveUsageHint(commands, 'watch pause')).toEqual({
      head: '/watch pause',
      slots: [],
      description: 'Pause for everyone'
    });
    // The placeholder stands in for the name of the argument being typed.
    expect(resolveUsageHint(commands, 'watch play ')!.slots).toEqual([
      { label: '[YouTube link, .mp4, .m3u8]', active: true }
    ]);
  });

  test('a plain command walks its arguments', () => {
    expect(resolveUsageHint(commands, 'deploy ')).toEqual({
      head: '/deploy',
      slots: [
        { label: '<target>', active: true },
        { label: '[note]', active: false }
      ],
      description: 'Ship a build'
    });
    expect(resolveUsageHint(commands, 'deploy prod fi')!.slots).toEqual([
      { label: '<target>', active: false },
      { label: '[note]', active: true }
    ]);
  });

  test('the live-region sentences read the whole line', () => {
    expect(usageHintText(resolveUsageHint(commands, 'watch seek ')!)).toBe(
      '/watch seek <90> — Jump everyone to a position'
    );
    expect(paletteItemText(resolvePalette(commands, 'watch ')!.items[1]!)).toBe(
      '/watch pause — Pause for everyone'
    );
    expect(paletteItemText(resolvePalette(commands, 'deploy ')!.items[1]!)).toBe('stage');
  });
});
