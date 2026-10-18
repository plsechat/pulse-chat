import {
  argToken,
  commandSignature,
  subcommandSignature,
  type TCommandArg,
  type TCommandArgChoice,
  type TCommandInfo,
  type TSubcommandInfo
} from '@pulse/shared';

/**
 * The command palette's reasoning, kept pure: what the text after the
 * `/` means (which level is being typed — a command, one of its
 * sub-commands, a choice for an argument, or an argument the composer
 * cannot complete), which rows to offer, what a row inserts, and the
 * usage line shown above the composer while arguments are typed.
 *
 * The rule that keeps Enter sending: a token that exactly names a
 * command, a sub-command or a choice is complete, so nothing is
 * offered for it any more. `/watch pause` shows no list; `/watch pau`
 * offers `pause`.
 */

const MAX_ROWS = 10;

type TPaletteItemBase = {
  /** Stable DOM id for `aria-activedescendant`. */
  id: string;
  /** What the row reads as its name (`/watch`, `pause`, `Production`). */
  title: string;
  description?: string;
  /** The usage line under the title, when there is one. */
  signature?: string;
  /** The text the composer holds after the row is picked (the whole `/…` run). */
  insert: string;
  /** The plugin's logo, for the row. */
  logo?: string;
};

export type TPaletteItem = TPaletteItemBase &
  (
    | { kind: 'command'; command: TCommandInfo }
    | { kind: 'subcommand'; command: TCommandInfo; subcommand: TSubcommandInfo }
    | { kind: 'choice'; command: TCommandInfo; arg: TCommandArg; choice: TCommandArgChoice }
  );

export type TPaletteLevel = 'commands' | 'subcommands' | 'choices';

export type TPalette = {
  level: TPaletteLevel;
  /** The list's header line and accessible name. */
  heading: string;
  items: TPaletteItem[];
};

export type TUsageSlot = {
  label: string;
  /** The argument the cursor is in. */
  active: boolean;
};

export type TUsageHint = {
  /** `/watch seek` — the part already typed. */
  head: string;
  slots: TUsageSlot[];
  description?: string;
};

type TQuery = {
  tokens: string[];
  /** The text ends in whitespace: the last token is complete, a new one begins. */
  trailingSpace: boolean;
};

/** Tokens as the server will read them: whitespace-separated, quotes kept together. */
const splitQuery = (query: string): TQuery => {
  const tokens = query.match(/"[^"]*"?|'[^']*'?|\S+/g) ?? [];
  return { tokens, trailingSpace: tokens.length > 0 && /\s$/.test(query) };
};

const findCommand = (
  commands: TCommandInfo[],
  name: string | undefined
): TCommandInfo | undefined =>
  name ? commands.find((c) => c.name.toLowerCase() === name.toLowerCase()) : undefined;

const findSubcommand = (
  command: TCommandInfo,
  name: string | undefined
): TSubcommandInfo | undefined =>
  name
    ? command.subcommands?.find((s) => s.name === name.toLowerCase())
    : undefined;

const domId = (...parts: string[]) =>
  `command-option-${parts.join('-').replace(/[^a-z0-9-]+/gi, '_')}`;

const commandItem = (command: TCommandInfo): TPaletteItem => ({
  kind: 'command',
  id: domId(command.pluginId, command.name),
  command,
  title: `/${command.name}`,
  description: command.description,
  signature: commandSignature(command),
  insert: `/${command.name} `,
  logo: command.logo
});

const subcommandItem = (
  command: TCommandInfo,
  subcommand: TSubcommandInfo
): TPaletteItem => ({
  kind: 'subcommand',
  id: domId(command.pluginId, command.name, subcommand.name),
  command,
  subcommand,
  title: subcommand.name,
  description: subcommand.description,
  signature: subcommandSignature(command, subcommand),
  insert: `/${command.name} ${subcommand.name} `,
  logo: command.logo
});

const choiceItem = (
  command: TCommandInfo,
  arg: TCommandArg,
  choice: TCommandArgChoice,
  typedBefore: string[]
): TPaletteItem => ({
  kind: 'choice',
  id: domId(command.pluginId, command.name, arg.name, choice.value),
  command,
  arg,
  choice,
  title: choice.label ?? choice.value,
  description: choice.description,
  signature: choice.label ? choice.value : undefined,
  insert: `${[`/${command.name}`, ...typedBefore, choice.value].join(' ')} `,
  logo: command.logo
});

/**
 * Commands whose name, plugin id or description match what is typed,
 * name prefixes first, shorter names before longer ones among those.
 */
const filterCommands = (commands: TCommandInfo[], typed: string): TCommandInfo[] => {
  const lower = typed.toLowerCase();
  if (!lower) return commands.slice(0, MAX_ROWS);

  return commands
    .filter(
      (c) =>
        c.name.toLowerCase().includes(lower) ||
        c.pluginId.toLowerCase().startsWith(lower) ||
        (c.description && c.description.toLowerCase().includes(lower))
    )
    .sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aStartsWith = aName.startsWith(lower);
      const bStartsWith = bName.startsWith(lower);
      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      if (aStartsWith && bStartsWith) return aName.length - bName.length;
      return 0;
    })
    .slice(0, MAX_ROWS);
};

/** Verbs are short and few: a name prefix is the one match that reads right. */
const filterSubcommands = (
  command: TCommandInfo,
  typed: string
): TSubcommandInfo[] => {
  const lower = typed.toLowerCase();
  return (command.subcommands ?? [])
    .filter((s) => s.name.startsWith(lower))
    .slice(0, MAX_ROWS);
};

/**
 * The choices for the argument the cursor is in, when it offers any:
 * `argTokens` are the arguments typed after the command (or verb).
 */
const choicesFor = (
  command: TCommandInfo,
  args: TCommandArg[],
  argTokens: string[],
  trailingSpace: boolean,
  typedBefore: string[]
): TPalette | null => {
  const index = trailingSpace ? argTokens.length : argTokens.length - 1;
  const arg = args[index];
  if (!arg?.choices?.length) return null;

  const typed = trailingSpace ? '' : (argTokens[index] ?? '');
  const lower = typed.toLowerCase();
  // An exact value is complete: nothing more to offer, Enter sends.
  if (arg.choices.some((c) => c.value.toLowerCase() === lower)) return null;

  const items = arg.choices
    .filter(
      (c) =>
        c.value.toLowerCase().startsWith(lower) ||
        c.label?.toLowerCase().startsWith(lower)
    )
    .slice(0, MAX_ROWS)
    .map((choice) =>
      choiceItem(command, arg, choice, [...typedBefore, ...argTokens.slice(0, index)])
    );
  return items.length > 0 ? { level: 'choices', heading: arg.name, items } : null;
};

/**
 * What to offer for `query` (the text after the `/`): the command
 * list, the verbs of a command, the choices of an argument — or
 * nothing, while an argument the composer cannot complete is typed.
 */
const resolvePalette = (commands: TCommandInfo[], query: string): TPalette | null => {
  const { tokens, trailingSpace } = splitQuery(query);

  if (tokens.length === 0) {
    const items = commands.slice(0, MAX_ROWS).map(commandItem);
    return items.length > 0 ? { level: 'commands', heading: 'Commands', items } : null;
  }

  if (tokens.length === 1 && !trailingSpace) {
    const items = filterCommands(commands, tokens[0]!).map(commandItem);
    return items.length > 0 ? { level: 'commands', heading: 'Commands', items } : null;
  }

  const command = findCommand(commands, tokens[0]);
  if (!command) return null;
  const rest = tokens.slice(1);

  if (command.subcommands && command.subcommands.length > 0) {
    const verb = rest[0];
    const subcommand = findSubcommand(command, verb);
    const verbComplete =
      subcommand !== undefined || rest.length > 1 || (rest.length === 1 && trailingSpace);

    if (!verbComplete) {
      const items = filterSubcommands(command, verb ?? '').map((s) =>
        subcommandItem(command, s)
      );
      return items.length > 0
        ? { level: 'subcommands', heading: `/${command.name}`, items }
        : null;
    }

    if (subcommand) {
      return choicesFor(command, subcommand.args ?? [], rest.slice(1), trailingSpace, [
        subcommand.name
      ]);
    }
    // A verb the command does not know: the command's own arguments
    // take the tokens (the spelling it accepted before it had verbs).
    return choicesFor(command, command.args ?? [], rest, trailingSpace, []);
  }

  return choicesFor(command, command.args ?? [], rest, trailingSpace, []);
};

const slotsFor = (
  args: TCommandArg[],
  argTokens: string[],
  trailingSpace: boolean
): TUsageSlot[] => {
  const index = trailingSpace ? argTokens.length : argTokens.length - 1;
  return args.map((arg, i) => {
    const active = i === index;
    const label =
      active && arg.placeholder
        ? arg.required
          ? `<${arg.placeholder}>`
          : `[${arg.placeholder}]`
        : argToken(arg);
    return { label, active };
  });
};

/**
 * The usage line for what is being typed, once the command name is
 * complete: `/watch seek <seconds>` with the argument the cursor is
 * in marked. For a command with sub-commands the verbs are the first
 * slot until one is named; its own positional arguments are never
 * shown (the verbs are the spelling to learn).
 */
const resolveUsageHint = (commands: TCommandInfo[], query: string): TUsageHint | null => {
  const { tokens, trailingSpace } = splitQuery(query);
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && !trailingSpace) return null;

  const command = findCommand(commands, tokens[0]);
  if (!command) return null;
  const rest = tokens.slice(1);

  if (command.subcommands && command.subcommands.length > 0) {
    const subcommand = findSubcommand(command, rest[0]);
    if (!subcommand) {
      return {
        head: `/${command.name}`,
        slots: [{ label: command.subcommands.map((s) => s.name).join(' | '), active: true }],
        description: command.description
      };
    }
    return {
      head: `/${command.name} ${subcommand.name}`,
      slots: slotsFor(subcommand.args ?? [], rest.slice(1), trailingSpace),
      description: subcommand.description ?? command.description
    };
  }

  return {
    head: `/${command.name}`,
    slots: slotsFor(command.args ?? [], rest, trailingSpace),
    description: command.description
  };
};

/**
 * The command query in the text before the cursor, as the `/`
 * suggestion sees it: a slash at the start of the (single) line, the
 * query everything after it. `null` when the text is no command.
 */
const commandQueryFromText = (textBeforeCursor: string): string | null => {
  if (!textBeforeCursor.startsWith('/')) return null;
  if (textBeforeCursor.includes('\n')) return null;
  return textBeforeCursor.slice(1);
};

/** The hint as one sentence, for a live region. */
const usageHintText = (hint: TUsageHint): string =>
  [hint.head, ...hint.slots.map((s) => s.label)].join(' ') +
  (hint.description ? ` — ${hint.description}` : '');

/** The row as one sentence, for a live region. */
const paletteItemText = (item: TPaletteItem): string =>
  (item.signature ?? item.title) + (item.description ? ` — ${item.description}` : '');

export {
  commandQueryFromText,
  paletteItemText,
  resolvePalette,
  resolveUsageHint,
  splitQuery,
  usageHintText
};
