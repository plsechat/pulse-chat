import {
  PLUGIN_SDK_VERSION,
  type PluginContext,
  type PluginSettings,
  type TCreateStreamOptions,
  type TExternalStreamHandle,
  type UnloadPluginContext
} from '@pulse/plugin-sdk';
import {
  ServerEvents,
  StreamKind,
  type CommandDefinition,
  type RegisteredCommand,
  type TCommandsMapByPlugin,
  type TInvokerContext,
  type TLogEntry,
  type TPluginCapability,
  type TPluginInfo,
  type TPluginSettingDefinition,
  type TPluginSettingsResponse
} from '@pulse/shared';
import chalk from 'chalk';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import type http from 'http';
import fs from 'node:fs/promises';
import path from 'path';
import semver from 'semver';
import { z } from 'zod';
import { db } from '../db';
import { getInstanceServerSettings } from '../db/queries/server';
import { getServerMemberIds } from '../db/queries/servers';
import { channels, pluginData, servers } from '../db/schema';
import { zPluginPackageJson } from './package-json-schema';
import { PLUGINS_PATH } from '../helpers/paths';
import { logger } from '../logger';
import { VoiceRuntime } from '../runtimes/voice';
import { fileExists } from '../utils/file-manager';
import { pubsub } from '../utils/pubsub';
import { createChannelActions } from './actions/channels';
import { createEventActions } from './actions/events';
import { createFileActions } from './actions/files';
import { createMemberActions } from './actions/members';
import { createMessageActions } from './actions/messages';
import { eventBus } from './event-bus';
import { createPluginFetch } from './fetch';
import { parseActionInput, PluginActionError } from './errors';
import {
  createPluginHttpRouteHandler,
  pluginHttp,
  type TParsedPluginUrl
} from './http';
import {
  isSealedSetting,
  sealPluginSecret,
  unsealPluginSecret
} from './secret-settings';
import {
  deliverPluginNotify,
  emitPluginLifecycle,
  hasPluginNotifySubscribers,
  onPluginLoaded,
  onPluginNotify,
  onPluginUnloaded
} from './subscriptions';

/**
 * Versions whose public API this SDK still contains in full. A plugin
 * whose `pulse.sdk` range admits one of these loads even though the
 * running version is outside the range: 0.2 added actions, events and
 * HTTP ingress, 0.3 added secret settings, `server.notify` and hot
 * reload, and neither removed anything, so a `^0.1` or `^0.2` plugin
 * runs unchanged. Remove an entry here the release something is
 * actually taken away.
 */
const SDK_BACKWARD_COMPATIBLE_RANGES = ['0.1.x', '0.2.x'];

/**
 * `ctx.server.notify` bounds. The topic is a short identifier; the
 * payload is whatever the subscriber expects, measured as the JSON it
 * serialises to (Bun is single-threaded — a plugin handing the server
 * a megabyte per call would be a self-inflicted stall).
 */
const MAX_NOTIFY_TOPIC_LENGTH = 64;
const MAX_NOTIFY_PAYLOAD_BYTES = 16 * 1024;
const notifyTopicSchema = z.string().min(1).max(MAX_NOTIFY_TOPIC_LENGTH);

/**
 * Copies of a changed entry file live here, inside the plugin's own
 * directory. The runtime caches a module by its path for the life of
 * the process (a query string does not make a new module), so a plugin
 * toggled on after its file changed is imported from a fresh path.
 */
const RUNTIME_COPIES_DIR = '.runtime';

/** What the last import of a plugin's entry looked like, for hot reload. */
type TEntryImport = { entryPath: string; mtime: number; importPath: string };

/**
 * Keys in plugin_data.settings the plugin never sees and the settings
 * UI never lists: loader-owned state stored next to the plugin's own
 * values. Prefixed so a plugin cannot register a colliding key.
 */
const RESERVED_SETTINGS_PREFIX = '__';
const HTTP_SECRET_SETTING_KEY = `${RESERVED_SETTINGS_PREFIX}httpSecret`;

const isReservedSettingKey = (key: string) => key.startsWith(RESERVED_SETTINGS_PREFIX);

type PluginModule = {
  onLoad: (ctx: PluginContext) => void | Promise<void>;
  onUnload?: (ctx: UnloadPluginContext) => void | Promise<void>;
};

type PluginStatesMap = Record<string, boolean>;

class PluginManager {
  private loadedPlugins = new Map<string, PluginModule>();
  private loadErrors = new Map<string, string>();
  // Plugins whose `pulse.sdk` range the running SDK does not satisfy.
  // Populated by getPluginInfo; load() refuses to import them.
  private sdkIncompatible = new Set<string>();
  private logs = new Map<string, TLogEntry[]>();
  private logsListeners = new Map<string, Set<(newLog: TLogEntry) => void>>();
  private commands = new Map<string, RegisteredCommand[]>();
  private pluginStates: PluginStatesMap = {};
  private settingDefinitions = new Map<string, TPluginSettingDefinition[]>();
  private settingValues = new Map<string, Record<string, unknown>>();
  // Declared in package.json; read by getPluginInfo before load() runs
  // onLoad, so an action can consult it from the first call.
  private capabilities = new Map<string, Set<TPluginCapability>>();
  // Resolved lazily from plugin_data (minted on first use); the promise
  // is cached so concurrent first requests share one mint.
  private httpSecrets = new Map<string, Promise<string | undefined>>();
  // One token per load: a context handed to an earlier load of the
  // same plugin (kept by a timer the plugin forgot to clear, say) is
  // recognised as stale and its `server.notify` calls are dropped.
  private loadTokens = new Map<string, symbol>();
  private entryImports = new Map<string, TEntryImport>();
  private handlePluginHttp = createPluginHttpRouteHandler({
    isPluginLoaded: (pluginId) => this.isPluginLoaded(pluginId),
    getPluginSecret: (pluginId) => this.getPluginHttpSecret(pluginId),
    logPlugin: (pluginId, type, ...message) =>
      this.logPlugin(pluginId, type, ...message)
  });

  private loadPluginStates = async () => {
    try {
      await this.migratePluginStatesFile();

      const rows = await db
        .select({
          pluginId: pluginData.pluginId,
          enabled: pluginData.enabled
        })
        .from(pluginData);

      this.pluginStates = rows.reduce<PluginStatesMap>((acc, row) => {
        acc[row.pluginId] = row.enabled;
        return acc;
      }, {});
    } catch (error) {
      logger.error('Failed to load plugin states:', error);
      this.pluginStates = {};
    }
  };

  private migratePluginStatesFile = async () => {
    const statesFile = path.join(PLUGINS_PATH, 'plugin-states.json');

    try {
      if (!(await fileExists(statesFile))) return;

      const content = await fs.readFile(statesFile, 'utf-8');
      const states = JSON.parse(content) as PluginStatesMap;

      const entries = Object.entries(states).map(([pluginId, enabled]) => ({
        pluginId,
        enabled,
        serverId: 1
      }));

      if (entries.length > 0) {
        for (const entry of entries) {
          await db
            .insert(pluginData)
            .values(entry)
            .onConflictDoUpdate({
              target: [pluginData.pluginId, pluginData.serverId],
              set: { enabled: entry.enabled }
            });
        }
      }

      await fs.unlink(statesFile);
    } catch (error) {
      logger.error('Failed to migrate plugin states file:', error);
    }
  };

  private getPluginEnabledFromDb = async (pluginId: string) => {
    const rows = await db
      .select({ enabled: pluginData.enabled })
      .from(pluginData)
      .where(eq(pluginData.pluginId, pluginId));

    return rows[0]?.enabled ?? false;
  };

  private ensurePluginState = async (pluginId: string) => {
    if (this.pluginStates[pluginId] !== undefined) return;

    const enabled = await this.getPluginEnabledFromDb(pluginId);
    this.pluginStates[pluginId] = enabled;
  };

  private isPluginEnabled = (pluginId: string): boolean => {
    return this.pluginStates[pluginId] ?? false;
  };

  private setPluginEnabled = async (pluginId: string, enabled: boolean) => {
    this.pluginStates[pluginId] = enabled;

    await db
      .insert(pluginData)
      .values({ pluginId, enabled, serverId: 1 })
      .onConflictDoUpdate({
        target: [pluginData.pluginId, pluginData.serverId],
        set: { enabled }
      });
  };

  public getCommandByName = (
    commandName: string | undefined
  ): RegisteredCommand | undefined => {
    if (!commandName) {
      return undefined;
    }

    for (const commands of this.commands.values()) {
      const foundCommand = commands.find((c) => c.name === commandName);

      if (foundCommand) {
        return foundCommand;
      }
    }

    return undefined;
  };

  public getPluginsFromPath = async (): Promise<string[]> => {
    const files = await fs.readdir(PLUGINS_PATH);
    const result: string[] = [];

    logger.debug(`Found ${files.length} plugins`);

    for (const file of files) {
      try {
        // check if it's a directory
        const pluginPath = path.join(PLUGINS_PATH, file);
        const stat = await fs.stat(pluginPath);

        if (!stat.isDirectory()) continue;

        result.push(file);
      } catch {
        // ignore
      }
    }

    return result;
  };

  /**
   * Boot-time load of every plugin directory, gated on the BOOTSTRAP
   * server row's `enablePlugins` (plugins are instance-level; the
   * instance owner's server is the instance's row). The `settings`
   * table has the same column, but nothing writes it, so gating on it
   * meant plugins could never load on any install.
   */
  public loadPlugins = async () => {
    const { enablePlugins } = await getInstanceServerSettings();

    if (!enablePlugins) return;

    await this.loadPluginStates();

    const files = await this.getPluginsFromPath();

    logger.info(`Loading ${files.length} plugins...`);

    for (const file of files) {
      try {
        await this.load(file);
      } catch (error) {
        logger.error(
          `Failed to load plugin ${file}: ${(error as Error).message}`
        );
      }
    }
  };

  public unloadPlugins = async () => {
    for (const pluginId of this.loadedPlugins.keys()) {
      try {
        await this.unload(pluginId);
      } catch (error) {
        logger.error(
          `Failed to unload plugin ${pluginId}: ${(error as Error).message}`
        );
      }
    }
  };

  public onLog = (pluginId: string, listener: (newLog: TLogEntry) => void) => {
    if (!this.logsListeners.has(pluginId)) {
      this.logsListeners.set(pluginId, new Set());
    }

    this.logsListeners.get(pluginId)!.add(listener);

    return () => {
      const listeners = this.logsListeners.get(pluginId);

      if (listeners) {
        listeners.delete(listener);

        if (listeners.size === 0) {
          this.logsListeners.delete(pluginId);
        }
      }
    };
  };

  public getLogs = (pluginId: string): TLogEntry[] => {
    return this.logs.get(pluginId) || [];
  };

  private logPlugin = (
    pluginId: string,
    type: 'info' | 'error' | 'debug',
    ...message: unknown[]
  ) => {
    if (!this.logs.has(pluginId)) {
      this.logs.set(pluginId, []);
    }

    const loggerFn = logger[type];
    const parsedMessage = message
      .map((m) => (typeof m === 'object' ? JSON.stringify(m) : String(m)))
      .join(' ');

    loggerFn(`${chalk.magentaBright(`[plugin:${pluginId}]`)} ${parsedMessage}`);

    const pluginLogs = this.logs.get(pluginId)!;

    const newLog: TLogEntry = {
      type,
      timestamp: Date.now(),
      message: parsedMessage,
      pluginId
    };

    pluginLogs.push(newLog);

    // keep only the last 1000 logs per plugin
    if (pluginLogs.length > 1000) {
      pluginLogs.shift();
    }

    const listeners = this.logsListeners.get(pluginId);

    if (listeners) {
      for (const listener of listeners) {
        listener(newLog);
      }
    }

    pubsub.publish(ServerEvents.PLUGIN_LOG, newLog);
  };

  private validatePluginId = (pluginId: string) => {
    // prevent path traversal attacks (e.g. "../../etc/passwd")
    if (
      pluginId.includes('..') ||
      pluginId.includes('/') ||
      pluginId.includes('\\') ||
      pluginId.includes('\0')
    ) {
      throw new Error(`Invalid plugin ID: '${pluginId}'`);
    }
  };

  private getSdkCompatError = (
    range: string | undefined
  ): string | undefined => {
    if (range === undefined) return undefined;

    if (semver.validRange(range) === null) {
      return `invalid pulse.sdk range "${range}"`;
    }

    if (semver.satisfies(PLUGIN_SDK_VERSION, range)) return undefined;

    // Written against an older minor this SDK is a superset of.
    if (
      SDK_BACKWARD_COMPATIBLE_RANGES.some((compatible) =>
        semver.intersects(range, compatible)
      )
    ) {
      return undefined;
    }

    return `requires @pulse/plugin-sdk ${range}, server provides ${PLUGIN_SDK_VERSION}`;
  };

  private getPluginPath = (pluginId: string) => {
    this.validatePluginId(pluginId);
    return path.join(PLUGINS_PATH, pluginId);
  };

  private unregisterPluginCommands = (pluginId: string) => {
    const pluginCommands = this.commands.get(pluginId);

    if (!pluginCommands || pluginCommands.length === 0) {
      return;
    }

    const commandNames = pluginCommands.map((c) => c.name);

    this.commands.delete(pluginId);

    this.logPlugin(
      pluginId,
      'debug',
      `Unregistered ${commandNames.length} command(s): ${commandNames.join(', ')}`
    );
  };

  public executeCommand = async <TArgs = unknown>(
    pluginId: string,
    commandName: string,
    invokerCtx: TInvokerContext,
    args: TArgs
  ): Promise<unknown> => {
    const isEnabled = this.isPluginEnabled(pluginId);

    if (!isEnabled) {
      throw new Error(`Plugin '${pluginId}' is not enabled.`);
    }

    const commands = this.commands.get(pluginId);

    if (!commands) {
      throw new Error(`Plugin '${pluginId}' has no registered commands.`);
    }

    const foundCommand = commands.find((c) => c.name === commandName);

    if (!foundCommand) {
      throw new Error(
        `Command '${commandName}' not found for plugin '${pluginId}'.`
      );
    }

    try {
      this.logPlugin(
        pluginId,
        'debug',
        `Executing command '${commandName}' with args:`,
        this.redactCommandArgs(pluginId, commandName, args)
      );

      return await foundCommand.command.executes(invokerCtx, args);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logPlugin(
        pluginId,
        'error',
        `Error executing command '${commandName}': ${errorMessage}`
      );

      throw error;
    }
  };

  /**
   * Copy of `args` with every argument the command declared `sensitive`
   * replaced by a placeholder. Used for the plugin log stream and the
   * activity log — the real values only ever reach the command itself.
   */
  public redactCommandArgs = <TArgs>(
    pluginId: string,
    commandName: string,
    args: TArgs
  ): TArgs => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return args;
    }

    const definition = this.commands
      .get(pluginId)
      ?.find((c) => c.name === commandName)?.command.args;
    const sensitiveNames = new Set(
      (definition ?? []).filter((a) => a.sensitive).map((a) => a.name)
    );

    if (sensitiveNames.size === 0) return args;

    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      redacted[key] = sensitiveNames.has(key) ? '[redacted]' : value;
    }

    return redacted as TArgs;
  };

  /**
   * Whether plugin *commands* may be executed from `serverId`. Plugins
   * load and unload at the instance level (instance owner only); this
   * per-server flag is the one thing a server owner controls about them.
   */
  public commandsEnabledForServer = async (
    serverId: number | undefined
  ): Promise<boolean> => {
    if (serverId === undefined) return false;

    const [server] = await db
      .select({ enablePlugins: servers.enablePlugins })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    return server?.enablePlugins === true;
  };

  public getCommands = (): TCommandsMapByPlugin => {
    const allCommands: TCommandsMapByPlugin = {};

    for (const [pluginId, commands] of this.commands.entries()) {
      allCommands[pluginId] = commands.map(({ name, description, args }) => ({
        pluginId,
        name,
        description,
        args
      }));
    }

    return allCommands;
  };

  public hasCommand = (pluginId: string, commandName: string): boolean => {
    const commands = this.commands.get(pluginId);

    if (!commands) {
      return false;
    }

    return commands.some((c) => c.name === commandName);
  };

  public togglePlugin = async (pluginId: string, enabled: boolean) => {
    await this.ensurePluginState(pluginId);
    const wasEnabled = this.isPluginEnabled(pluginId);

    await this.setPluginEnabled(pluginId, enabled);

    // was enabled and is now being disabled
    if (wasEnabled && !enabled && this.loadedPlugins.has(pluginId)) {
      await this.unload(pluginId);
    }

    // was disabled and is now being enabled
    if (!wasEnabled && enabled && !this.loadedPlugins.has(pluginId)) {
      await this.load(pluginId);
    }
  };

  /** Whether the plugin's module is currently loaded (onLoad ran). */
  public isPluginLoaded = (pluginId: string): boolean =>
    this.loadedPlugins.has(pluginId);

  public unload = async (pluginId: string) => {
    const pluginModule = this.loadedPlugins.get(pluginId);

    if (!pluginModule) {
      this.logPlugin(
        pluginId,
        'debug',
        `Plugin ${pluginId} is not loaded; nothing to unload.`
      );
      return;
    }

    if (typeof pluginModule.onUnload === 'function') {
      try {
        const unloadCtx = this.createUnloadContext(pluginId);

        await pluginModule.onUnload(unloadCtx);
      } catch (error) {
        logger.error(`Error in plugin ${pluginId} onUnload:`, error);
      }
    }

    eventBus.unload(pluginId);
    this.unregisterPluginCommands(pluginId);
    this.unregisterPluginHttpRoutes(pluginId);
    this.settingDefinitions.delete(pluginId);
    this.settingValues.delete(pluginId);
    // The secret lives in plugin_data; the next load re-reads it there.
    this.httpSecrets.delete(pluginId);
    this.loadTokens.delete(pluginId);
    this.loadedPlugins.delete(pluginId);

    logger.info(`Plugin unloaded: ${pluginId}`);

    await this.emitLifecycle('unloaded', pluginId);
  };

  /**
   * Server-side hooks on the plugin lifecycle and on `ctx.server.notify`
   * (plugins/subscriptions.ts holds the registry; a feature that must
   * subscribe while its module evaluates imports that module directly,
   * see the note there). `onPluginLoaded` fires after `onLoad`
   * succeeded (boot and toggle alike), `onPluginUnloaded` after an
   * unload finished; listeners are awaited, a failing one is logged
   * under the plugin and does not stop the rest. `onNotify` is scoped
   * to one plugin id and topic. Each returns the unsubscribe.
   */
  public onPluginLoaded = onPluginLoaded;
  public onPluginUnloaded = onPluginUnloaded;
  public onNotify = onPluginNotify;

  private emitLifecycle = (what: 'loaded' | 'unloaded', pluginId: string) =>
    emitPluginLifecycle(what, pluginId, (message) => {
      this.logPlugin(pluginId, 'error', message);
    });

  private deliverNotify = (pluginId: string, topic: string, payload: unknown) => {
    if (!hasPluginNotifySubscribers(pluginId, topic)) {
      this.logPlugin(pluginId, 'debug', `Nothing on the server listens to '${topic}'`);
      return;
    }

    deliverPluginNotify(pluginId, topic, payload, (message) => {
      this.logPlugin(pluginId, 'error', message);
    });
  };

  private unregisterPluginHttpRoutes = (pluginId: string) => {
    const count = pluginHttp.routeCount(pluginId);

    if (count === 0) return;

    pluginHttp.unregisterAll(pluginId);
    this.logPlugin(pluginId, 'debug', `Unregistered ${count} HTTP route(s)`);
  };

  /** Whether the plugin's manifest declares `capability`. */
  public hasCapability = (
    pluginId: string,
    capability: TPluginCapability
  ): boolean => this.capabilities.get(pluginId)?.has(capability) ?? false;

  /**
   * The secret a caller must present to reach the plugin's HTTP routes.
   * Minted once (32 random bytes) when the plugin first registers a
   * route and kept in plugin_data under a reserved key, so it survives
   * restarts and the instance owner can read it from the settings
   * route. Undefined for a plugin that never registered a route.
   */
  public getPluginHttpSecret = (
    pluginId: string,
    { createIfMissing = false }: { createIfMissing?: boolean } = {}
  ): Promise<string | undefined> => {
    const cached = this.httpSecrets.get(pluginId);

    if (cached) {
      return createIfMissing
        ? cached.then((secret) => secret ?? this.mintHttpSecret(pluginId))
        : cached;
    }

    const lookup = this.loadSettingsFromDb(pluginId).then((values) => {
      const stored = values[HTTP_SECRET_SETTING_KEY];

      if (typeof stored === 'string' && stored.length > 0) return stored;

      return createIfMissing ? this.mintHttpSecret(pluginId) : undefined;
    });

    this.httpSecrets.set(pluginId, lookup);

    return lookup;
  };

  private mintHttpSecret = async (pluginId: string): Promise<string> => {
    const secret = randomBytes(32).toString('hex');
    const minted = Promise.resolve<string | undefined>(secret);

    this.httpSecrets.set(pluginId, minted);

    await this.saveSettingsToDb(pluginId, this.settingValues.get(pluginId) ?? {}, {
      [HTTP_SECRET_SETTING_KEY]: secret
    });

    this.logPlugin(pluginId, 'debug', 'Generated the HTTP endpoint secret');

    return secret;
  };

  /** The `/plugins/<id>/<path>` mount's entry point (http/index.ts). */
  public handleHttpRequest = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsed: TParsedPluginUrl
  ) => this.handlePluginHttp(req, res, parsed);

  public getPluginInfo = async (pluginId: string): Promise<TPluginInfo> => {
    await this.ensurePluginState(pluginId);
    const pluginPath = this.getPluginPath(pluginId);
    const packageJsonPath = path.join(pluginPath, 'package.json');

    if (!(await fileExists(packageJsonPath))) {
      throw new Error('package.json not found');
    }

    const packageJson = zPluginPackageJson.parse(
      JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
    );

    const entryFilePath = path.join(pluginPath, packageJson.pulse.entry);

    if (!(await fileExists(entryFilePath))) {
      throw new Error('Plugin entry file not found');
    }

    const sdkError = this.getSdkCompatError(packageJson.pulse.sdk);

    if (sdkError) {
      this.sdkIncompatible.add(pluginId);
      this.loadErrors.set(pluginId, sdkError);
    } else {
      this.sdkIncompatible.delete(pluginId);
    }

    const loadError = this.loadErrors.get(pluginId);
    const capabilities = packageJson.pulse.capabilities ?? [];

    this.capabilities.set(pluginId, new Set(capabilities));

    return {
      id: pluginId,
      enabled: this.isPluginEnabled(pluginId),
      name: packageJson.name,
      path: pluginPath,
      description: packageJson.pulse.description,
      version: packageJson.version,
      logo: packageJson.pulse.logo,
      author: packageJson.pulse.author,
      homepage: packageJson.pulse.homepage,
      entry: entryFilePath,
      capabilities,
      loadError
    };
  };

  /**
   * Loads one plugin. Deliberately NOT gated on the instance
   * `enablePlugins` flag: `togglePlugin` is the instance owner's explicit
   * intent to run this plugin now, so it loads even while the boot-time
   * flag is off (the flag only decides what loads on the next start).
   */
  public load = async (pluginId: string) => {
    if (!this.isPluginEnabled(pluginId)) {
      this.logPlugin(
        pluginId,
        'debug',
        `Plugin ${pluginId} is disabled; skipping load.`
      );
      return;
    }

    const info = await this.getPluginInfo(pluginId);

    if (this.sdkIncompatible.has(pluginId)) {
      this.logPlugin(
        pluginId,
        'error',
        `Failed to load plugin ${pluginId}: ${this.loadErrors.get(pluginId)}`
      );
      return;
    }

    try {
      const loadToken = Symbol(pluginId);
      this.loadTokens.set(pluginId, loadToken);

      const ctx = this.createContext(pluginId, loadToken);
      const mod = await import(await this.resolveEntryImport(pluginId, info.entry));

      if (typeof mod.onLoad !== 'function') {
        throw new Error(
          `Plugin ${pluginId} does not export an 'onLoad' function`
        );
      }

      await mod.onLoad(ctx);

      this.loadedPlugins.set(pluginId, mod);
      this.loadErrors.delete(pluginId);

      this.logPlugin(
        pluginId,
        'info',
        `Plugin loaded: ${pluginId}@v${info.version} by ${info.author}`
      );

      await this.emitLifecycle('loaded', pluginId);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.loadErrors.set(pluginId, errorMessage);

      this.logPlugin(
        pluginId,
        'error',
        `Failed to load plugin ${pluginId}: ${errorMessage}`
      );

      await this.unload(pluginId);
    }
  };

  /**
   * The path to import for a plugin's entry. The runtime caches a module
   * by path for the life of the process, so once an entry has been
   * imported, toggling the plugin off and on again would run the code
   * from the first load no matter what is on disk now. When the entry's
   * mtime differs from the one last imported, the file is copied to
   * `<plugin dir>/.runtime/<name>.<mtime>.js` and that copy is imported;
   * older copies are removed. Only the entry is copied: a relative
   * import inside it does not resolve from the copy, so a plugin that
   * wants hot reload ships as one bundled file (the README says so).
   * The first import in a process, and every import while the file is
   * unchanged, use the path last imported — the original or the copy.
   */
  private resolveEntryImport = async (
    pluginId: string,
    entryPath: string
  ): Promise<string> => {
    const mtime = Math.floor((await fs.stat(entryPath)).mtimeMs);
    const previous = this.entryImports.get(pluginId);

    if (!previous || previous.entryPath !== entryPath) {
      this.entryImports.set(pluginId, { entryPath, mtime, importPath: entryPath });
      return entryPath;
    }

    if (previous.mtime === mtime) return previous.importPath;

    const runtimeDir = path.join(this.getPluginPath(pluginId), RUNTIME_COPIES_DIR);
    const ext = path.extname(entryPath);
    const base = path.basename(entryPath, ext);
    const copyName = `${base}.${mtime}${ext}`;
    const importPath = path.join(runtimeDir, copyName);

    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.copyFile(entryPath, importPath);

    for (const name of await fs.readdir(runtimeDir)) {
      if (name === copyName || !name.startsWith(`${base}.`) || !name.endsWith(ext)) continue;
      await fs.rm(path.join(runtimeDir, name), { force: true });
    }

    this.entryImports.set(pluginId, { entryPath, mtime, importPath });
    this.logPlugin(
      pluginId,
      'debug',
      `Entry file changed since the last load; running ${path.relative(this.getPluginPath(pluginId), importPath)}`
    );

    return importPath;
  };

  private loadSettingsFromDb = async (
    pluginId: string
  ): Promise<Record<string, unknown>> => {
    const rows = await db
      .select()
      .from(pluginData)
      .where(eq(pluginData.pluginId, pluginId));

    if (rows.length > 0 && rows[0]!.settings) {
      return rows[0]!.settings;
    }

    return {};
  };

  /** The keys of the plugin's registered `secret` settings. */
  private secretSettingKeys = (pluginId: string): Set<string> =>
    new Set(
      (this.settingDefinitions.get(pluginId) ?? [])
        .filter((def) => def.type === 'secret')
        .map((def) => def.key)
    );

  /**
   * Persist the plugin's setting values. Reserved (loader-owned) keys
   * already in the row are carried over so a settings write never drops
   * the HTTP secret; `reserved` adds or replaces them. `values` is the
   * in-memory map (plaintext secrets): every secret is sealed on the
   * way out, an unset one is stored as an empty string.
   */
  private saveSettingsToDb = async (
    pluginId: string,
    values: Record<string, unknown>,
    reserved: Record<string, unknown> = {}
  ) => {
    const enabled = this.pluginStates[pluginId] ?? true;
    const existing = await this.loadSettingsFromDb(pluginId);
    const kept: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(existing)) {
      if (isReservedSettingKey(key)) kept[key] = value;
    }

    const stored: Record<string, unknown> = { ...values };

    for (const key of this.secretSettingKeys(pluginId)) {
      const plaintext = stored[key];
      stored[key] =
        typeof plaintext === 'string' && plaintext.length > 0
          ? sealPluginSecret(plaintext)
          : '';
    }

    const settings = { ...kept, ...reserved, ...stored };

    await db
      .insert(pluginData)
      .values({ pluginId, enabled, settings, serverId: 1 })
      .onConflictDoUpdate({
        target: [pluginData.pluginId, pluginData.serverId],
        set: { settings }
      });
  };

  private registerSettings = async (
    pluginId: string,
    definitions: readonly TPluginSettingDefinition[]
  ): Promise<PluginSettings> => {
    this.settingDefinitions.set(pluginId, [...definitions]);

    // load existing values from DB, merge with defaults
    const dbValues = await this.loadSettingsFromDb(pluginId);
    const merged: Record<string, unknown> = {};

    for (const def of definitions) {
      if (def.type === 'secret') {
        merged[def.key] = this.readStoredSecret(pluginId, def, dbValues[def.key]);
        continue;
      }

      merged[def.key] =
        dbValues[def.key] !== undefined ? dbValues[def.key] : def.defaultValue;
    }

    this.settingValues.set(pluginId, merged);

    // persist merged values back (in case new defaults were added; a
    // secret that was stored in the clear is sealed by this write)
    await this.saveSettingsToDb(pluginId, merged);

    this.logPlugin(
      pluginId,
      'debug',
      `Registered ${definitions.length} setting(s): ${definitions.map((d) => d.key).join(', ')}`
    );

    return {
      get: (key: string) => {
        const values = this.settingValues.get(pluginId);
        if (!values) return undefined;
        return values[key];
      },
      set: (key: string, value: unknown) => {
        const values = this.settingValues.get(pluginId);
        if (!values) return;

        const def = this.settingDefinitions
          .get(pluginId)
          ?.find((d) => d.key === key);
        if (!def) {
          this.logPlugin(
            pluginId,
            'error',
            `Setting key '${key}' is not registered.`
          );
          return;
        }

        if (def.type === 'secret' && typeof value !== 'string') {
          this.logPlugin(
            pluginId,
            'error',
            `Setting '${key}' is a secret and takes a string.`
          );
          return;
        }

        values[key] = value;

        // persist async without blocking
        this.saveSettingsToDb(pluginId, values).catch((err) => {
          this.logPlugin(
            pluginId,
            'error',
            `Failed to persist setting '${key}':`,
            err
          );
        });
      }
    };
  };

  /**
   * The plaintext of a stored `secret` setting for the in-memory map:
   * a sealed envelope is opened; a plain non-empty string is a value
   * written before the setting became a secret (it is sealed by the
   * save that follows registration); anything else is unset. An
   * envelope this instance cannot open (sealed under another secret,
   * or damaged) is reported and treated as unset — the owner sets the
   * value again.
   */
  private readStoredSecret = (
    pluginId: string,
    def: TPluginSettingDefinition,
    stored: unknown
  ): string => {
    if (isSealedSetting(stored)) {
      try {
        return unsealPluginSecret(stored);
      } catch {
        this.logPlugin(
          pluginId,
          'error',
          `The stored value of secret setting '${def.key}' cannot be decrypted on this instance; set it again.`
        );
        return '';
      }
    }

    if (typeof stored === 'string' && stored.length > 0) {
      this.logPlugin(
        pluginId,
        'info',
        `Setting '${def.key}' is now a secret: its stored value is encrypted from here on.`
      );
      return stored;
    }

    return typeof def.defaultValue === 'string' ? def.defaultValue : '';
  };

  /** `values` as a client may see them: a secret is `{ set }`, never the text or the envelope. */
  private maskSecretValues = (
    definitions: readonly TPluginSettingDefinition[],
    values: Record<string, unknown>
  ): Record<string, unknown> => {
    const masked: Record<string, unknown> = { ...values };

    for (const def of definitions) {
      if (def.type !== 'secret') continue;

      const value = values[def.key];
      masked[def.key] = {
        set: isSealedSetting(value) || (typeof value === 'string' && value.length > 0)
      };
    }

    return masked;
  };

  public getPluginSettings = async (
    pluginId: string
  ): Promise<TPluginSettingsResponse> => {
    const definitions = this.settingDefinitions.get(pluginId) || [];
    let values = this.settingValues.get(pluginId);

    if (!values) {
      // plugin might not be loaded, try reading from DB
      const dbValues = await this.loadSettingsFromDb(pluginId);
      values = {};

      for (const def of definitions) {
        values[def.key] =
          dbValues[def.key] !== undefined
            ? dbValues[def.key]
            : def.defaultValue;
      }
    }

    const httpSecret = await this.getPluginHttpSecret(pluginId);

    return {
      definitions,
      values: this.maskSecretValues(definitions, values),
      ...(httpSecret !== undefined ? { httpSecret } : {})
    };
  };

  public updatePluginSetting = async (
    pluginId: string,
    key: string,
    value: unknown
  ) => {
    const definitions = this.settingDefinitions.get(pluginId);

    if (!definitions) {
      throw new Error(`Plugin '${pluginId}' has no registered settings.`);
    }

    const def = definitions.find((d) => d.key === key);

    if (!def) {
      throw new Error(
        `Setting '${key}' is not registered for plugin '${pluginId}'.`
      );
    }

    const values = this.settingValues.get(pluginId) || {};

    if (def.type === 'secret') {
      // A new value replaces the old one, null clears it; neither is
      // ever logged. Pasted tokens tend to carry a stray newline.
      if (value !== null && typeof value !== 'string') {
        throw new Error(`Setting '${key}' is a secret and takes a string or null.`);
      }

      const plaintext = value === null ? '' : value.trim();
      values[key] = plaintext;
      this.settingValues.set(pluginId, values);

      await this.saveSettingsToDb(pluginId, values);

      this.logPlugin(
        pluginId,
        'debug',
        `Secret setting '${key}' ${plaintext.length > 0 ? 'replaced' : 'cleared'}`
      );
      return;
    }

    if (value === null) {
      throw new Error(`Setting '${key}' cannot be cleared; it is not a secret.`);
    }

    values[key] = value;
    this.settingValues.set(pluginId, values);

    await this.saveSettingsToDb(pluginId, values);

    this.logPlugin(pluginId, 'debug', `Setting '${key}' updated to:`, value);
  };

  private createContext = (pluginId: string, loadToken: symbol): PluginContext => {
    const log = (...message: unknown[]) => {
      this.logPlugin(pluginId, 'info', ...message);
    };

    return {
      path: this.getPluginPath(pluginId),
      log,
      debug: (...message: unknown[]) => {
        this.logPlugin(pluginId, 'debug', ...message);
      },
      error: (...message: unknown[]) => {
        this.logPlugin(pluginId, 'error', ...message);
      },
      events: {
        on: (event, handler) => {
          eventBus.register(pluginId, event, handler);
        }
      },
      fetch: createPluginFetch(pluginId),
      server: {
        notify: (rawTopic, payload) => {
          const topic = parseActionInput(notifyTopicSchema, rawTopic);
          const serialised = payload === undefined ? '' : JSON.stringify(payload);

          if (serialised === undefined) {
            throw new PluginActionError('BAD_REQUEST', 'payload must serialise to JSON');
          }

          if (Buffer.byteLength(serialised) > MAX_NOTIFY_PAYLOAD_BYTES) {
            throw new PluginActionError(
              'BAD_REQUEST',
              `payload may not exceed ${MAX_NOTIFY_PAYLOAD_BYTES} bytes as JSON`
            );
          }

          if (this.loadTokens.get(pluginId) !== loadToken) {
            this.logPlugin(pluginId, 'debug', `Dropped '${topic}' from an unloaded instance of the plugin`);
            return;
          }

          this.deliverNotify(pluginId, topic, payload);
        }
      },
      http: {
        register: (routePath, handler) => {
          const { path: canonical, replaced } = pluginHttp.register(
            pluginId,
            routePath,
            handler
          );

          // Mint the secret now so the owner can copy it from the
          // settings panel before the first request arrives.
          this.getPluginHttpSecret(pluginId, { createIfMissing: true }).catch(
            (err) => {
              this.logPlugin(
                pluginId,
                'error',
                'Failed to prepare the HTTP endpoint secret:',
                err
              );
            }
          );

          this.logPlugin(
            pluginId,
            'debug',
            `${replaced ? 'Replaced' : 'Registered'} HTTP route /plugins/${pluginId}/${canonical}`
          );
        }
      },
      actions: {
        messages: createMessageActions({
          pluginId,
          hasCapability: (capability) => this.hasCapability(pluginId, capability),
          log
        }),
        channels: createChannelActions(pluginId),
        members: createMemberActions(),
        files: createFileActions(),
        events: createEventActions(pluginId),
        voice: {
          getRouter: (channelId: number) => {
            const channel = VoiceRuntime.findById(channelId);

            if (!channel) {
              throw new Error(
                `Voice runtime not found for channel ID ${channelId}`
              );
            }

            return channel.getRouter();
          },
          createStream: (
            options: TCreateStreamOptions
          ): TExternalStreamHandle => {
            const channel = VoiceRuntime.findById(options.channelId);

            if (!channel) {
              throw new Error(
                `Voice runtime not found for channel ID ${options.channelId}`
              );
            }

            const streamId = channel.createExternalStream({
              title: options.title,
              key: options.key,
              pluginId,
              avatarUrl: options.avatarUrl,
              producers: options.producers
            });

            const stream = channel.getState().externalStreams[streamId]!;

            // Scope to server members (fire-and-forget, createStream is sync)
            db.select({ serverId: channels.serverId })
              .from(channels)
              .where(eq(channels.id, options.channelId))
              .limit(1)
              .then(([ch]) => {
                if (!ch) return;
                return getServerMemberIds(ch.serverId).then((memberIds) => {
                  pubsub.publishFor(
                    memberIds,
                    ServerEvents.VOICE_ADD_EXTERNAL_STREAM,
                    {
                      channelId: options.channelId,
                      streamId,
                      stream
                    }
                  );
                });
              });

            if (options.producers.audio) {
              pubsub.publishForChannel(
                channel.key,
                ServerEvents.VOICE_NEW_PRODUCER,
                {
                  channelId: options.channelId,
                  remoteId: streamId,
                  kind: StreamKind.EXTERNAL_AUDIO
                }
              );
            }

            if (options.producers.video) {
              pubsub.publishForChannel(
                channel.key,
                ServerEvents.VOICE_NEW_PRODUCER,
                {
                  channelId: options.channelId,
                  remoteId: streamId,
                  kind: StreamKind.EXTERNAL_VIDEO
                }
              );
            }

            this.logPlugin(
              pluginId,
              'debug',
              `Created external stream '${options.title}' (key: ${options.key}, id: ${streamId}) with tracks: audio=${!!options.producers.audio}, video=${!!options.producers.video}`
            );

            return {
              streamId,
              remove: () => {
                channel.removeExternalStream(streamId);

                this.logPlugin(
                  pluginId,
                  'debug',
                  `Removed external stream '${options.title}' (key: ${options.key}, id: ${streamId})`
                );
              },
              update: (updateOptions) => {
                channel.updateExternalStream(streamId, updateOptions);

                this.logPlugin(
                  pluginId,
                  'debug',
                  `Updated external stream '${options.title}' (key: ${options.key}, id: ${streamId})`
                );
              }
            };
          },
          getListenInfo: () => VoiceRuntime.getListenInfo()
        }
      },
      commands: {
        register: <TArgs = void>(command: CommandDefinition<TArgs>) => {
          if (!this.commands.has(pluginId)) {
            this.commands.set(pluginId, []);
          }

          const pluginCommands = this.commands.get(pluginId)!;

          const existingIndex = pluginCommands.findIndex(
            (c) => c.name === command.name
          );

          if (existingIndex !== -1) {
            this.logPlugin(
              pluginId,
              'error',
              `Command '${command.name}' is already registered. Overwriting.`
            );
            pluginCommands.splice(existingIndex, 1);
          }

          pluginCommands.push({
            pluginId,
            name: command.name,
            description: command.description,
            args: command.args,
            command
          });

          this.logPlugin(
            pluginId,
            'debug',
            `Registered command: ${command.name}${command.description ? ` - ${command.description}` : ''}`
          );
        }
      },
      settings: {
        register: (definitions) => {
          return this.registerSettings(pluginId, definitions) as ReturnType<
            PluginContext['settings']['register']
          >;
        }
      }
    };
  };

  private createUnloadContext = (pluginId: string): UnloadPluginContext => {
    return {
      log: (...message: unknown[]) => {
        this.logPlugin(pluginId, 'info', ...message);
      },
      debug: (...message: unknown[]) => {
        this.logPlugin(pluginId, 'debug', ...message);
      },
      error: (...message: unknown[]) => {
        this.logPlugin(pluginId, 'error', ...message);
      }
    };
  };
}

const pluginManager = new PluginManager();

export { pluginManager };
