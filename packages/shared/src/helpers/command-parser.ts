import type {
  RegisteredCommand,
  TCommandElement,
  TParsedDomCommand,
  TParsedDomCommandStatus,
} from "../plugins";

/**
 * The `<command>` element a command message is stored as. With a
 * `subcommand` the arguments are named after that sub-command's
 * declaration (`/watch seek 90` → `seconds: 90`), else after the
 * command's own.
 */
const toDomCommand = (
  command: RegisteredCommand & {
    imageUrl?: string;
    status: "pending" | "completed" | "failed";
    response?: unknown;
    subcommand?: string;
  },
  args: unknown[]
): string => {
  const argDefs =
    command.subcommand !== undefined
      ? command.subcommands?.find((s) => s.name === command.subcommand)?.args
      : command.args;
  const sanitizedArgs =
    argDefs?.map((argDef, index) => {
      const argValue = args[index];

      if (argDef.sensitive) {
        return { name: argDef.name, value: "****", status: command.status };
      }

      return { name: argDef.name, value: argValue, status: command.status };
    }) || [];

  const responseString =
    command.response !== undefined
      ? typeof command.response === "string"
        ? command.response
        : JSON.stringify(command.response, null, 2)
      : "";

  const logoAttr = command.imageUrl
    ? ` data-plugin-logo="${command.imageUrl}"`
    : '';
  const subcommandAttr = command.subcommand
    ? ` data-subcommand="${command.subcommand}"`
    : '';

  return `<command data-plugin-id="${command.pluginId}"${logoAttr} data-command="${command.name}"${subcommandAttr} data-args='${JSON.stringify(
    sanitizedArgs
  )}' data-status='${command.status}' data-response='${responseString}'></command>`;
};

const COMMAND_STATUSES: readonly TParsedDomCommandStatus[] = [
  "pending",
  "completed",
  "failed",
];

const isCommandStatus = (value: unknown): value is TParsedDomCommandStatus =>
  typeof value === "string" &&
  (COMMAND_STATUSES as readonly string[]).includes(value);

const nonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid command: ${field} is required`);
  }
  return value;
};

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid command: ${field} must be a string`);
  }
  return value;
};

/**
 * Validate a decoded `<command>` element. This runs in the client on
 * every rendered command, so it is a hand-written check rather than a
 * schema library: @pulse/shared ships in the browser bundle and must
 * not drag a validator in with it. The rules are the ones the message
 * author's instance applied when it wrote the element (toDomCommand).
 */
const parseDomCommand = (domElement: TCommandElement): TParsedDomCommand => {
  const argsString = domElement.attribs["data-args"];

  let rawArgs: unknown;

  try {
    rawArgs = JSON.parse(argsString || "[]");
  } catch {
    throw new Error("Invalid command arguments JSON");
  }

  if (!Array.isArray(rawArgs)) {
    throw new Error("Invalid command: args must be an array");
  }

  const args = rawArgs.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Invalid command: each arg must be an object");
    }
    const { name, value } = entry as { name?: unknown; value?: unknown };
    if (typeof name !== "string") {
      throw new Error("Invalid command: arg name must be a string");
    }
    return { name, value };
  });

  const rawStatus = domElement.attribs["data-status"];
  // Absent = pending (a freshly sent command has no outcome yet).
  const status = rawStatus === undefined ? "pending" : rawStatus;
  if (!isCommandStatus(status)) {
    throw new Error("Invalid command: unknown status");
  }

  const logo = optionalString(domElement.attribs["data-plugin-logo"], "logo");
  let parsedLogo: string | undefined;
  if (logo !== undefined) {
    const trimmed = logo.trim();
    try {
      new URL(trimmed);
    } catch {
      throw new Error("Invalid command: logo must be a URL");
    }
    parsedLogo = trimmed;
  }

  const parsed: TParsedDomCommand = {
    pluginId: nonEmptyString(domElement.attribs["data-plugin-id"], "pluginId"),
    commandName: nonEmptyString(
      domElement.attribs["data-command"],
      "commandName"
    ),
    status,
    args,
  };
  const response = optionalString(
    domElement.attribs["data-response"],
    "response"
  );
  if (response !== undefined) parsed.response = response;
  if (parsedLogo !== undefined) parsed.logo = parsedLogo;
  const subcommand = optionalString(
    domElement.attribs["data-subcommand"],
    "subcommand"
  );
  if (subcommand) parsed.subcommand = subcommand;

  return parsed;
};

export { parseDomCommand, toDomCommand };
