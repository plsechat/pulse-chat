import type { TCommandArg, TSubcommandDefinition } from "../plugins";

/**
 * How a command reads as a line of usage — the composer's command list
 * and hint, and the reply a command answers with when it is typed
 * without the sub-command it needs, all draw on the same words.
 */

type TCommandLike = {
  name: string;
  description?: string;
  args?: TCommandArg[];
  subcommands?: TSubcommandDefinition[];
};

type TSubcommandLike = Pick<TSubcommandDefinition, "name" | "description" | "args">;

/** `<name>` for a required argument, `[name]` for an optional one. */
const argToken = (arg: TCommandArg): string =>
  arg.required ? `<${arg.name}>` : `[${arg.name}]`;

const argTokens = (args: TCommandArg[] | undefined): string[] =>
  (args ?? []).map(argToken);

/** The sub-commands a member may be offered: hidden ones stay out. */
const listedSubcommands = (
  command: Pick<TCommandLike, "subcommands">
): TSubcommandDefinition[] =>
  (command.subcommands ?? []).filter((sub) => !sub.hidden);

/** `/watch play [link]`. */
const subcommandSignature = (
  command: Pick<TCommandLike, "name">,
  sub: TSubcommandLike
): string =>
  [`/${command.name} ${sub.name}`, ...argTokens(sub.args)].join(" ");

/**
 * `/greet <who>` for a plain command; for one with sub-commands the
 * verbs it offers, `/watch play | pause | seek | stop | status`.
 */
const commandSignature = (command: TCommandLike): string => {
  const subs = listedSubcommands(command);
  if (subs.length > 0) {
    return `/${command.name} ${subs.map((sub) => sub.name).join(" | ")}`;
  }
  return [`/${command.name}`, ...argTokens(command.args)].join(" ");
};

/**
 * The reply to `/name` on a command that only acts through its
 * sub-commands: every listed verb with its signature and description,
 * one per line.
 */
const commandUsage = (command: TCommandLike): string => {
  const subs = listedSubcommands(command);
  const lines = subs.map((sub) =>
    sub.description
      ? `${subcommandSignature(command, sub)} — ${sub.description}`
      : subcommandSignature(command, sub)
  );
  const head = `Usage: /${command.name} <${subs.map((sub) => sub.name).join(" | ")}>`;
  return [head, ...lines].join("\n");
};

export {
  argToken,
  commandSignature,
  commandUsage,
  listedSubcommands,
  subcommandSignature,
};
