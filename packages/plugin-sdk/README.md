# Pulse Plugin SDK

TypeScript types for building Pulse server plugins. SDK version: `0.1.0`.

> [!NOTE]
> Plugins are experimental. The `PluginContext` API may change between minor versions. Declare the SDK range your plugin was built against (`pulse.sdk`, below) so the server refuses a mismatched plugin with a clear load error instead of failing at runtime.

## How plugins run

- A plugin is a plain ES module that the server `import()`s **into its own process**. A plugin can do anything the server can — only install plugins you trust.
- Plugins are instance-global: one plugin directory per Pulse data directory, shared by every server on the instance.
- Plugins load at boot when the **Enable plugins** server setting is on, and are all unloaded or reloaded when that setting flips. Individual plugins are switched with the `plugins.toggle` procedure, which needs the **Manage plugins** permission (held by the instance owner). The settings page for this is being restored in the admin UI; until then the procedure is the only switch.

## Creating a plugin

### 1. Scaffold

Run `bun init` in a new folder (e.g. `my-plugin`) and set up `package.json` like this:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "pulse": {
    "entry": "index.js",
    "sdk": "^0.1",
    "author": "Me",
    "description": "My first Pulse plugin",
    "homepage": "https://example.com/my-plugin",
    "logo": "https://example.com/logo.png"
  },
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun --minify --format esm && cp package.json dist/"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5"
  }
}
```

The server validates these fields (`zPluginPackageJson` in `@pulse/shared`):

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Plugin name shown to admins |
| `version` | yes | Semver (`1.2.3`, optional pre-release suffix) |
| `pulse.entry` | yes | Compiled entry file; **must end in `.js`** |
| `pulse.sdk` | recommended (optional this release, required from the next) | Semver range of the plugin SDK the plugin targets, e.g. `^0.1`. The server checks its own SDK version (`PLUGIN_SDK_VERSION`) against it and records a load error — `requires @pulse/plugin-sdk ^0.1, server provides 0.2.0`, or `invalid pulse.sdk range` — instead of importing the module when it does not satisfy. A plugin without the field loads with no check. |
| `pulse.author` | yes | Author name |
| `pulse.description` | yes | One-line description |
| `pulse.homepage` | no | URL |
| `pulse.logo` | no | Logo URL or filename |

### 2. Get the types

`@pulse/plugin-sdk` is a private workspace package and is not published to any registry. The SDK is type-only, so either:

- build the plugin inside a checkout of the Pulse monorepo (any folder under `apps/*` or `packages/*` resolves `@pulse/plugin-sdk` through the Bun workspace), or
- copy `packages/plugin-sdk/src/index.ts` and `packages/shared/src/plugins.ts` into your project, point the `@pulse/shared` import at your copy, and add `mediasoup` (the version pinned in `packages/plugin-sdk/package.json`) as a dev dependency for the re-exported mediasoup types.

Either way the compiled plugin has no runtime dependency on the SDK.

### 3. Entry file

```typescript
import type { PluginContext, UnloadPluginContext } from "@pulse/plugin-sdk";

const settingDefinitions = [
  { key: "greeting", name: "Greeting", type: "string", defaultValue: "Hello" },
  { key: "shout", name: "Shout", type: "boolean", defaultValue: false },
] as const;

const onLoad = async (ctx: PluginContext) => {
  const settings = await ctx.settings.register(settingDefinitions);

  ctx.events.on("user:joined", ({ userId, username, serverId }) => {
    ctx.log(`${username} (#${userId}) opened server ${serverId}`);
  });

  ctx.events.on("user:left", ({ username, serverId }) => {
    ctx.log(`${username} left server ${serverId}`);
  });

  ctx.commands.register({
    name: "greet",
    description: "Greet someone",
    args: [{ name: "who", type: "string", required: true }],
    async executes(invoker, args: { who: string }) {
      const text = `${settings.get("greeting")}, ${args.who}!`;
      return settings.get("shout") ? text.toUpperCase() : text;
    },
  });
};

const onUnload = (ctx: UnloadPluginContext) => {
  ctx.log("Bye");
};

export { onLoad, onUnload };
```

Build it: `bun run build` writes `dist/index.js` and copies `package.json` next to it.

### 4. Install

The plugin directory is `<data dir>/plugins/<plugin-id>/`, where the data directory is:

- Linux: `$XDG_CONFIG_HOME/pulse` (default `~/.config/pulse`); the Docker image mounts it at `/root/.config/pulse`
- macOS: `~/Library/Application Support/pulse`
- Windows: `%APPDATA%\pulse`
- running the server from source: `apps/server/data/`

1. Create `plugins/my-plugin/` there (the folder name is the plugin id) and copy the contents of `dist/` into it.
2. Turn on **Enable plugins** in the server settings if it is off.
3. Enable the plugin: `plugins.toggle({ pluginId: "my-plugin", enabled: true })`. A plugin that is already enabled is also picked up by a server restart.
4. Watch its log (`plugins.getLogs`, or the plugin log view once the admin page is back). A failed `onLoad` shows as `loadError` in `plugins.getPlugins`.

## Lifecycle

### `onLoad(ctx: PluginContext)` — required

Called when the plugin is enabled (at boot, or when toggled on). Register event listeners, commands and settings here. If `onLoad` throws, the error is recorded as the plugin's `loadError`, `onUnload` runs, and the plugin stays unloaded.

### `onUnload(ctx: UnloadPluginContext)` — optional

Called on unload: when the plugin is toggled off, when the instance-wide **Enable plugins** setting is turned off, and after a failed `onLoad`. Graceful-shutdown support (running `onUnload` when the server process receives SIGTERM/SIGINT) is being added; until it lands a process stop does **not** call it, so do not rely on `onUnload` for durable state — persist as you go.

`UnloadPluginContext` only has `log` / `debug` / `error`. Event listeners, commands and settings definitions are unregistered automatically after `onUnload` returns.

## API reference — `PluginContext`

Everything below is what `apps/server/src/plugins/index.ts` (`createContext`) actually provides.

### `path: string`

Absolute path of the plugin's directory.

### `log(...args)`, `debug(...args)`, `error(...args)`

Append to the plugin's log (levels `info` / `debug` / `error`), which admins read via `plugins.getLogs` and stream via `plugins.onPluginLog`.

### `events.on(event, handler)`

Subscribe to a server event. Handlers may be async; listeners are removed on unload.

| Event | Payload | Fired when |
| --- | --- | --- |
| `user:joined` | `{ userId, username, serverId }` | a user's client session connects and bootstraps a server (`others.join`) — fires on every connect, **not** when someone becomes a member |
| `user:left` | `{ userId, username, serverId }` | a user leaves, or is kicked or banned from, a server |
| `message:created` | `{ messageId, channelId, userId, content }` | a plaintext channel message is sent |
| `message:updated` | `{ messageId, channelId, userId, content }` | a plaintext channel message is edited |
| `message:deleted` | `{ messageId, channelId }` | a channel message is deleted (single, bulk, or report takedown) |
| `voice:runtime_initialized` | `{ channelId }` | a server voice channel's mediasoup router is created |
| `voice:runtime_closed` | `{ channelId }` | that router is destroyed |

`message:*` events are **not** emitted for end-to-end-encrypted messages, and no event covers DMs.

### `commands.register(command)`

Registers a slash command users can invoke from the composer.

```typescript
ctx.commands.register({
  name: "greet",
  description: "Greet a user",
  args: [
    { name: "username", type: "string", description: "Who to greet", required: true, sensitive: false },
  ],
  async executes(invoker: TInvokerContext, args: { username: string }) {
    return `Hello, ${args.username}!`;
  },
});
```

- `args[].type` is `"string" | "number" | "boolean"`; `sensitive: true` masks the value as `****` in the UI.
- `executes(invoker, args)` receives `{ userId, currentVoiceChannelId? }` and whatever it returns is shown to the invoker.
- Registering a name twice overwrites the first registration (and logs an error).

### `settings.register(definitions)` → `Promise<PluginSettings>`

Declares typed, admin-editable settings. Each definition is `{ key, name, description?, type: "string" | "number" | "boolean", defaultValue }`. Values persist in the database (`plugin_data`), merge over the defaults on every load, and admins can change them with `plugins.updateSetting` / read them with `plugins.getSettings`.

The returned object has `get(key)` and `set(key, value)`; `set` persists asynchronously and logs an error for an unregistered key. Pass the definitions `as const` to get typed `get`/`set`.

### `actions.voice`

- `getRouter(channelId)` — the mediasoup `Router` of a **server** voice channel runtime (DM calls are not addressable). Throws if no runtime exists for the id.
- `createStream({ channelId, title, key, avatarUrl?, producers: { audio?, video? } })` — publishes an external stream into the channel; it appears in the roster as a synthetic participant and every member gets the new producers announced. The producers must be created on that channel's router (typically via a `PlainTransport` you open yourself). Returns `{ streamId, remove(), update({ title?, avatarUrl?, producers? }) }`.
- `getListenInfo()` — `{ ip, announcedAddress }` the server's own WebRTC transports use, so your `PlainTransport` advertises the same address.

The SDK re-exports the mediasoup types you need for this (`Router`, `Producer`, `PlainTransport`, `RtpParameters`, …).

## Best practices

1. **Handle errors** — wrap async work in try/catch; an unhandled rejection inside a handler is logged but can leave your plugin in a half-initialised state.
2. **Clean up** in `onUnload`: close sockets, timers and transports you opened.
3. **Never block the event loop** (no `Bun.spawnSync`, no long synchronous loops) — the server is single-threaded and voice runs in the same process.
4. **Persist as you go**; do not count on `onUnload` running on a process stop (see Lifecycle).
5. **Declare `pulse.sdk`** (import `PLUGIN_SDK_VERSION` from the SDK if you want to assert it at build time) and bump the range when you adopt a new SDK version.
6. **Validate command arguments** before using them.

## License

This SDK is part of the Pulse project. See the main repository for license information.
