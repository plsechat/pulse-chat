/**
 * The plugin's package.json as the server loader reads it. Hand-written
 * (not inferred from a schema) so @pulse/shared stays free of zod — the
 * client bundles this package, and zod is server-only. The validating
 * schema is the server's plugins/package-json-schema.ts, which is
 * type-checked against this shape.
 */
/**
 * Elevated powers a plugin asks for in its package.json. Without the
 * declaration an action stays scoped to what the plugin itself created
 * (its own posted messages); the instance owner sees the list before
 * enabling the plugin.
 *
 * - `moderate-messages`: edit, delete and react to ANY channel message,
 *   not only the ones the plugin posted.
 */
export type TPluginCapability = "moderate-messages";

export type TPluginPackageJson = {
  version: string;
  name: string;
  pulse: {
    entry: string;
    /**
     * Semver range of @pulse/plugin-sdk the plugin was written against.
     * Optional for one release; the server refuses to load a plugin
     * whose range the running SDK version does not satisfy.
     */
    sdk?: string;
    author: string;
    homepage?: string;
    description: string;
    logo?: string;
    /** See TPluginCapability. Absent = none. */
    capabilities?: TPluginCapability[];
  };
};

export type TPluginInfo = {
  id: string;
  enabled: boolean;
  loadError?: string;
  author: TPluginPackageJson["pulse"]["author"];
  description: TPluginPackageJson["pulse"]["description"];
  version: TPluginPackageJson["version"];
  // Optional keys (not `string | undefined`): both are absent from the
  // plugin's package.json when unset, and the tRPC wire type drops
  // undefined-valued keys, so the client sees them as optional too.
  logo?: TPluginPackageJson["pulse"]["logo"];
  name: TPluginPackageJson["name"];
  homepage?: TPluginPackageJson["pulse"]["homepage"];
  path: string;
  entry: string;
  /** Declared capabilities (empty when the manifest declares none). */
  capabilities: TPluginCapability[];
};

export type TLogEntry = {
  type: "info" | "error" | "debug";
  timestamp: number;
  message: string;
  pluginId: string;
};

/**
 * One value an argument can take (SDK 0.4.0). The composer offers the
 * choices as a list while the argument is being typed and inserts
 * `value`; `label` is what the row reads when the value is terse.
 */
export type TCommandArgChoice = {
  value: string;
  label?: string;
  description?: string;
};

export type TCommandArg = {
  name: string;
  description?: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  sensitive?: boolean;
  /** Offered in the composer while this argument is typed (SDK 0.4.0). */
  choices?: TCommandArgChoice[];
  /** Shown in the composer's usage hint in place of the name (SDK 0.4.0). */
  placeholder?: string;
};

/** Bounds the registry enforces on a declaration (SDK 0.4.0). */
export const COMMAND_LIMITS = {
  /** Sub-commands a command may declare. */
  subcommands: 20,
  /** Arguments a command or a sub-command may declare. */
  args: 8,
  /** Choices an argument may offer. */
  choices: 32,
  /** Command, sub-command and argument names. */
  name: /^[a-z0-9-]{1,32}$/,
} as const;

/**
 * A verb under a command (SDK 0.4.0): `/name sub …`. The sub-command's
 * `args` follow its name positionally; a hidden sub-command can be
 * invoked (a client reporting state through the command) but is never
 * offered in the composer.
 */
export type TSubcommandDefinition = {
  name: string;
  description?: string;
  args?: TCommandArg[];
  hidden?: boolean;
};

/**
 * Who ran a command, as the server hands it to the plugin. The two
 * optional fields were added with SDK 0.3: `activeServerId` is the
 * server the command was run from, `canModerate` whether the invoker
 * holds MANAGE_USERS there (so a plugin can let room moderators act on
 * a session they did not start) — a 0.1/0.2 plugin never read them.
 * `channelId` is the text channel (or thread) whose composer the
 * command was typed into; absent when it came through
 * `plugins.executeCommand` (a button, the voice popover).
 */
export type TInvokerContext = {
  userId: number;
  currentVoiceChannelId?: number;
  activeServerId?: number;
  canModerate?: boolean;
  channelId?: number;
  /**
   * The sub-command that was invoked (`/name sub …`), SDK 0.4.0; absent
   * when the command was run on its own (`/name …`) — a plugin written
   * before sub-commands never sees it.
   */
  subcommand?: string;
};

/**
 * What a plugin registers. A command with `subcommands` is invoked as
 * `/name sub …` (`invoker.subcommand` names the verb, `args` holds that
 * sub-command's arguments); `/name` on its own runs the command with its
 * own `args` when it declares any, else answers with its usage.
 */
export interface CommandDefinition<TArgs = void> {
  name: string;
  description?: string;
  args?: TCommandArg[];
  subcommands?: TSubcommandDefinition[];
  executes(ctx: TInvokerContext, args: TArgs): Promise<unknown>;
}

export type TPluginCommand = {
  pluginId: string;
  name: string;
  description?: string;
};

/** A sub-command as the client sees it: hidden ones are never sent. */
export type TSubcommandInfo = Omit<TSubcommandDefinition, "hidden">;

export type TCommandInfo = {
  pluginId: string;
  name: string;
  description?: string;
  args?: CommandDefinition<unknown>["args"];
  subcommands?: TSubcommandInfo[];
  /** The plugin's manifest logo, for the composer's command list. */
  logo?: string;
};

export type TCommandsMapByPlugin = {
  [pluginId: string]: TCommandInfo[];
};

export type RegisteredCommand = {
  pluginId: string;
  name: string;
  description?: string;
  args?: CommandDefinition<unknown>["args"];
  subcommands?: TSubcommandDefinition[];
  command: CommandDefinition<unknown>;
};

export type TParsedDomCommandStatus = "pending" | "completed" | "failed";

/**
 * A `<command>` element decoded from message HTML. Validated by
 * helpers/command-parser.ts (parseDomCommand), which is what enforces
 * this shape at runtime.
 */
export type TParsedDomCommand = {
  pluginId: string;
  commandName: string;
  /** The verb of a `/name sub …` invocation (SDK 0.4.0). */
  subcommand?: string;
  status: TParsedDomCommandStatus;
  response?: string;
  logo?: string;
  args: { name: string; value: unknown }[];
};

export type TCommandElement = {
  attribs: {
    "data-plugin-id"?: string;
    "data-plugin-logo"?: string;
    "data-command"?: string;
    "data-subcommand"?: string;
    "data-status"?: string;
    "data-args"?: string;
    "data-response"?: string;
  };
};

/**
 * `secret`: a string the server stores encrypted under the instance's
 * file-signing secret and never returns — `plugins.getSettings` reports
 * it as `TPluginSecretSettingValue`, `plugins.updateSetting` takes a new
 * value or `null` to clear it, and only the plugin's own `settings.get`
 * sees the plaintext.
 */
export type TPluginSettingType = "string" | "number" | "boolean" | "secret";

export type TPluginSettingDefinition = {
  key: string;
  name: string;
  description?: string;
  type: TPluginSettingType;
  defaultValue: string | number | boolean;
};

/** What the settings route says about a `secret` setting: whether one is set, never what it is. */
export type TPluginSecretSettingValue = { set: boolean };

export type TPluginSettingsResponse = {
  definitions: TPluginSettingDefinition[];
  /** Per key; a `secret` setting is a `TPluginSecretSettingValue`, never the value. */
  values: Record<string, unknown>;
  /**
   * The secret external callers must send in `x-pulse-plugin-secret`
   * to reach the plugin's HTTP endpoints. Present once the plugin has
   * registered an endpoint; instance owner only (the settings route).
   */
  httpSecret?: string;
};
