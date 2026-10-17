import type {
  RegisteredCommand,
  TCommandArg,
  TSubcommandDefinition
} from '@pulse/shared';
import { parseArgsStringToArgv } from 'string-argv';

const parseCommandArgs = (plainText: string) => {
  const tokens = parseArgsStringToArgv(plainText);

  if (tokens.length === 0) {
    return { commandName: undefined, args: [] };
  }

  const commandName = tokens[0]?.startsWith('/')
    ? tokens[0].slice(1)
    : tokens[0];

  return {
    commandName,
    args: tokens.slice(1)
  };
};

type TCommandInvocation = {
  /** The verb the first token named, when the command has one by that name. */
  subcommand?: TSubcommandDefinition;
  /** The declarations the remaining tokens are read against, in order. */
  argDefs: TCommandArg[];
  /** The tokens that are arguments (the verb, when one was named, removed). */
  tokens: string[];
  /**
   * `/name …` on a command that only acts through sub-commands and the
   * first token named none of them: answer with the usage, run nothing.
   */
  usage: boolean;
};

/**
 * Which part of a command the typed tokens address (SDK 0.4.0). The
 * first token after the name is tried as a sub-command — hidden ones
 * included, a member may type what the composer does not offer — and
 * its arguments follow. When it names none, the command's own
 * arguments take every token (the positional spellings a plugin
 * accepted before it declared sub-commands keep working); a command
 * without arguments of its own has nothing to run then.
 */
const resolveCommandInvocation = (
  command: Pick<RegisteredCommand, 'args' | 'subcommands'>,
  tokens: string[]
): TCommandInvocation => {
  const subcommands = command.subcommands ?? [];
  if (subcommands.length === 0) {
    return { argDefs: command.args ?? [], tokens, usage: false };
  }

  const verb = tokens[0]?.toLowerCase();
  const subcommand = verb
    ? subcommands.find((sub) => sub.name === verb)
    : undefined;
  if (subcommand) {
    return {
      subcommand,
      argDefs: subcommand.args ?? [],
      tokens: tokens.slice(1),
      usage: false
    };
  }

  if (command.args && command.args.length > 0) {
    return { argDefs: command.args, tokens, usage: false };
  }

  return { argDefs: [], tokens, usage: true };
};

/**
 * The typed tokens as the argument object the command receives, each
 * read with its declared type; tokens beyond the declaration are
 * dropped, declared arguments nobody typed are absent.
 */
const coerceCommandArgs = (
  argDefs: TCommandArg[],
  tokens: string[]
): Record<string, unknown> => {
  const args: Record<string, unknown> = {};

  argDefs.forEach((argDef, index) => {
    if (index >= tokens.length) return;
    const value = tokens[index]!;

    if (argDef.type === 'number') {
      args[argDef.name] = Number(value);
    } else if (argDef.type === 'boolean') {
      args[argDef.name] = value === 'true';
    } else {
      args[argDef.name] = value;
    }
  });

  return args;
};

export { coerceCommandArgs, parseCommandArgs, resolveCommandInvocation };
