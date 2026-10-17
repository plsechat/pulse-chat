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

export type TCommandArg = {
  name: string;
  description?: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  sensitive?: boolean;
};

export type TInvokerContext = {
  userId: number;
  currentVoiceChannelId?: number;
};

export interface CommandDefinition<TArgs = void> {
  name: string;
  description?: string;
  args?: TCommandArg[];
  executes(ctx: TInvokerContext, args: TArgs): Promise<unknown>;
}

export type TPluginCommand = {
  pluginId: string;
  name: string;
  description?: string;
};

export type TCommandInfo = {
  pluginId: string;
  name: string;
  description?: string;
  args?: CommandDefinition<unknown>["args"];
};

export type TCommandsMapByPlugin = {
  [pluginId: string]: TCommandInfo[];
};

export type RegisteredCommand = {
  pluginId: string;
  name: string;
  description?: string;
  args?: CommandDefinition<unknown>["args"];
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
    "data-status"?: string;
    "data-args"?: string;
    "data-response"?: string;
  };
};

export type TPluginSettingType = "string" | "number" | "boolean";

export type TPluginSettingDefinition = {
  key: string;
  name: string;
  description?: string;
  type: TPluginSettingType;
  defaultValue: string | number | boolean;
};

export type TPluginSettingsResponse = {
  definitions: TPluginSettingDefinition[];
  values: Record<string, unknown>;
  /**
   * The secret external callers must send in `x-pulse-plugin-secret`
   * to reach the plugin's HTTP endpoints. Present once the plugin has
   * registered an endpoint; instance owner only (the settings route).
   */
  httpSecret?: string;
};
