import {
  COMMAND_LIMITS,
  type CommandDefinition,
  type TCommandArg
} from '@pulse/shared';

/**
 * The bounds a command declaration must keep to before the registry
 * accepts it (SDK 0.4.0). Everything here ends up in every member's
 * composer and in the usage reply, so a runaway declaration is a
 * client-side cost paid by everyone on the server. A plain command
 * (no sub-commands) is accepted as it always was; the rules bind the
 * sub-commands and what they carry.
 */

const MAX_CHOICE_VALUE_LENGTH = 64;
const MAX_PLACEHOLDER_LENGTH = 64;

const assertArgs = (args: TCommandArg[] | undefined, where: string) => {
  if (!args) return;
  if (args.length > COMMAND_LIMITS.args) {
    throw new Error(
      `${where} declares ${args.length} arguments; at most ${COMMAND_LIMITS.args} are allowed`
    );
  }
  for (const arg of args) {
    if (!COMMAND_LIMITS.name.test(arg.name)) {
      throw new Error(
        `${where}: argument name '${arg.name}' must match ${COMMAND_LIMITS.name}`
      );
    }
    if (arg.placeholder !== undefined && arg.placeholder.length > MAX_PLACEHOLDER_LENGTH) {
      throw new Error(
        `${where}: the placeholder of '${arg.name}' is longer than ${MAX_PLACEHOLDER_LENGTH} characters`
      );
    }
    if (arg.choices) {
      if (arg.choices.length > COMMAND_LIMITS.choices) {
        throw new Error(
          `${where}: '${arg.name}' offers ${arg.choices.length} choices; at most ${COMMAND_LIMITS.choices} are allowed`
        );
      }
      for (const choice of arg.choices) {
        if (choice.value.length === 0 || choice.value.length > MAX_CHOICE_VALUE_LENGTH) {
          throw new Error(
            `${where}: a choice of '${arg.name}' must be 1 to ${MAX_CHOICE_VALUE_LENGTH} characters`
          );
        }
      }
    }
  }
};

/** Throws with the reason when `command` is out of bounds. */
const assertCommandDefinition = (command: CommandDefinition<unknown>) => {
  const subcommands = command.subcommands;
  if (!subcommands) return;

  if (subcommands.length > COMMAND_LIMITS.subcommands) {
    throw new Error(
      `Command '${command.name}' declares ${subcommands.length} sub-commands; at most ${COMMAND_LIMITS.subcommands} are allowed`
    );
  }

  const seen = new Set<string>();
  for (const sub of subcommands) {
    if (!COMMAND_LIMITS.name.test(sub.name)) {
      throw new Error(
        `Command '${command.name}': sub-command name '${sub.name}' must match ${COMMAND_LIMITS.name}`
      );
    }
    if (seen.has(sub.name)) {
      throw new Error(
        `Command '${command.name}' declares sub-command '${sub.name}' twice`
      );
    }
    seen.add(sub.name);
    assertArgs(sub.args, `Sub-command '${command.name} ${sub.name}'`);
  }
};

export { assertCommandDefinition };
