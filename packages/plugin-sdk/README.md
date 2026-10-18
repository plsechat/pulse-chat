# Pulse Plugin SDK

TypeScript types for building Pulse server plugins. SDK version: `0.4.0` (see [CHANGELOG.md](./CHANGELOG.md)).

> [!NOTE]
> Plugins are experimental. The `PluginContext` API may change between minor versions. Declare the SDK range your plugin was built against (`pulse.sdk`, below) so the server refuses a mismatched plugin with a clear load error instead of failing at runtime. Every 0.x minor so far is a strict superset of the previous one: a `^0.1`, `^0.2` or `^0.3` plugin loads unchanged on a 0.4 server.

## How plugins run

- A plugin is a plain ES module that the server `import()`s **into its own process**. A plugin can do anything the server can — only install plugins you trust. The loader does not sandbox.
- Plugins are instance-global: one plugin directory per Pulse data directory, shared by every server on the instance.
- Plugins load at boot when the **Plugins** switch (Server Settings → General) of the instance owner's own server is on; flipping it later only decides what loads on the next start. Individual plugins are switched with the `plugins.toggle` procedure (instance owner) or the Instance → Plugins panel, and a toggle loads or unloads the plugin at once whatever the boot flag says. On every other server that switch gates only whether members may run plugin commands there.
- Everything a plugin does to chat (post, react, upload, create channels and threads, create events) is recorded under the **plugin's own account**: one system user per plugin, named after the manifest `name`, minted the first time the plugin acts and made a member of a server the first time it acts there (it shows in the member list labelled "Plugin"). It can never sign in; storage quotas land on it; auto-moderation treats it as the accountable user. What readers see on a message is still the optional per-post persona (`author`), the same split webhooks use.

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
    "sdk": "^0.4",
    "author": "Me",
    "description": "My first Pulse plugin",
    "homepage": "https://example.com/my-plugin",
    "logo": "https://example.com/logo.png",
    "capabilities": []
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

The server validates these fields (`zPluginPackageJson` in `apps/server/src/plugins/package-json-schema.ts`; the shape is `TPluginPackageJson` in `@pulse/shared`):

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Plugin name shown to admins |
| `version` | yes | Semver (`1.2.3`, optional pre-release suffix) |
| `pulse.entry` | yes | Compiled entry file; **must end in `.js`** |
| `pulse.sdk` | recommended | Semver range of the plugin SDK the plugin targets, e.g. `^0.4`. The server checks its own SDK version (`PLUGIN_SDK_VERSION`) against it and records a load error — `requires @pulse/plugin-sdk ^0.5, server provides 0.4.0`, or `invalid pulse.sdk range` — instead of importing the module when it does not satisfy. A range that admits an older 0.x minor this SDK still fully contains is accepted. A plugin without the field loads with no check. |
| `pulse.author` | yes | Author name |
| `pulse.description` | yes | One-line description |
| `pulse.homepage` | no | URL |
| `pulse.logo` | no | Logo URL or filename |
| `pulse.capabilities` | no | Elevated powers the plugin asks for; an unknown name fails validation. `"moderate-messages"`: `actions.messages.edit/delete/react` may touch **any** channel message, not only the plugin's own posts. Shown to the instance owner in the plugin list. |

### 2. Get the types

`@pulse/plugin-sdk` is a private workspace package and is not published to any registry. The SDK is type-only (plus the `PLUGIN_SDK_VERSION` constant and the `isPluginActionError` type guard), so either:

- build the plugin inside a checkout of the Pulse monorepo (any folder under `apps/*` or `packages/*` resolves `@pulse/plugin-sdk` through the Bun workspace), or
- copy `packages/plugin-sdk/src/index.ts` and `packages/shared/src/plugins.ts` into your project, point the `@pulse/shared` import at your copy, and add `mediasoup` (the version pinned in `packages/plugin-sdk/package.json`) as a dev dependency for the re-exported mediasoup types. Both files are plain TypeScript with no runtime imports into the server.

Either way the compiled plugin has no runtime dependency on the SDK.

### 3. Entry file

```typescript
import type { PluginContext, UnloadPluginContext } from "@pulse/plugin-sdk";

const settingDefinitions = [
  { key: "greeting", name: "Greeting", type: "string", defaultValue: "Hello" },
] as const;

const onLoad = async (ctx: PluginContext) => {
  const settings = await ctx.settings.register(settingDefinitions);

  ctx.events.on("member:joined", async ({ username, serverId }) => {
    const [general] = (await ctx.actions.channels.list(serverId)).filter((c) => c.type === "TEXT");
    if (!general) return;
    await ctx.actions.messages.post({
      channelId: general.id,
      content: `${settings.get("greeting")}, ${username}!`,
      author: { name: "Greeter" },
    });
  });

  ctx.commands.register({
    name: "greet",
    args: [{ name: "who", type: "string", required: true }],
    async executes(_invoker, args: { who: string }) {
      return `${settings.get("greeting")}, ${args.who}!`;
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
2. Turn on the **Plugins** switch under Server Settings → General if it is off (on the instance owner's server it lets enabled plugins load at boot; on any server it lets members run plugin commands).
3. Enable the plugin from Instance → Plugins (or `plugins.toggle({ pluginId: "my-plugin", enabled: true })`). A plugin that is already enabled is also picked up by a server restart while that switch is on.
4. Watch its log (the panel, or `plugins.getLogs`). A failed `onLoad` shows as `loadError` in the plugin list.

## Lifecycle

### `onLoad(ctx: PluginContext)` — required

Called when the plugin is enabled (at boot, or when toggled on). Register event listeners, commands, settings and HTTP routes here. If `onLoad` throws, the error is recorded as the plugin's `loadError`, `onUnload` runs, and the plugin stays unloaded.

**Hot reload.** Toggling a plugin off and on runs the entry file as it is on disk now: when its modification time changed since the last load in this process, the loader copies it to `<plugin dir>/.runtime/<name>.<mtime>.js` and imports the copy (the runtime caches a module by path for the life of the process, so the original path would run the old code); older copies are removed. Only the entry file is copied — a relative `import "./other.js"` inside it does not resolve from the copy — so bundle your plugin into one file (`bun build … --target bun`) if you want to update it without a server restart. Bare imports from the plugin's own `node_modules` keep resolving.

### `onUnload(ctx: UnloadPluginContext)` — optional

Called on unload: when the plugin is toggled off and after a failed `onLoad`. `UnloadPluginContext` only has `log` / `debug` / `error`. Event listeners, commands, settings definitions and HTTP routes are unregistered automatically after `onUnload` returns. Persist as you go — a process stop does not call `onUnload`.

## Errors from actions

Every `ctx.actions.*` and `ctx.fetch` rejection is an `Error` named `PluginActionError` with a `code`:

| code | meaning |
| --- | --- |
| `BAD_REQUEST` | input out of bounds, or the target cannot take the action (voice/encrypted channel, reply across channels, …) |
| `NOT_FOUND` | the id does not exist, or exists where the plugin may not reach it |
| `FORBIDDEN` | not the plugin's own message (and no `moderate-messages`), auto-moderation blocked the content, uploads disabled, quota exceeded |
| `CONFLICT` | a concurrent write won, or the message already has a thread |
| `UNAVAILABLE` | the feature is not installed on this server (e.g. `actions.events` without the scheduler) |

```typescript
import { isPluginActionError } from "@pulse/plugin-sdk";

try {
  await ctx.actions.messages.post({ channelId, content });
} catch (error) {
  if (isPluginActionError(error) && error.code === "BAD_REQUEST") ctx.error(error.message);
  else throw error;
}
```

## API reference — `PluginContext`

Everything below is what `apps/server/src/plugins/index.ts` (`createContext`) provides.

### `path: string`

Absolute path of the plugin's directory.

### `log(...args)`, `debug(...args)`, `error(...args)`

Append to the plugin's log (levels `info` / `debug` / `error`), which admins read in the panel, via `plugins.getLogs`, and stream via `plugins.onLog`.

### `events.on(event, handler)`

Subscribe to a server event. Handlers may be async; listeners are removed on unload.

| Event | Payload | Fired when |
| --- | --- | --- |
| `user:connected` | `{ userId, username, serverId }` | a member's client session connects and bootstraps a server — fires on every connect, **not** when someone becomes a member |
| `member:joined` | `{ userId, username, serverId }` | a user becomes a member of a server (invite, discover, federated join) |
| `member:left` | `{ userId, username, serverId }` | a user leaves, or is kicked or banned from, a server |
| `member:roles_changed` | `{ userId, serverId, roleIds }` | a member's role set in that server changed (granted, revoked, a held role deleted, ownership transferred); `roleIds` is the full set afterwards |
| `user:joined` / `user:left` | as above | **deprecated** aliases of `user:connected` / `member:left`; removed in v0.5.0 |
| `message:created` | `{ messageId, channelId, userId, content, pluginId?, replyToId?, attachments? }` | a plaintext channel message is sent; `pluginId` set when a plugin posted it (`userId` is then that plugin's account); `attachments` are `{ name, url, size }` served at `url` relative to the instance |
| `message:updated` | `{ messageId, channelId, userId, content, pluginId?, replyToId? }` | a plaintext channel message is edited |
| `message:deleted` | `{ messageId, channelId }` | a channel message is deleted (single, bulk, report takedown, or by a plugin); the row stays as a "Message deleted" tombstone until the instance's retention sweep removes it |
| `message:reaction` | `{ messageId, channelId, userId, emoji, added, pluginId? }` | a reaction is added (`added: true`) or removed, by a user or a plugin |
| `thread:created` | `{ threadId, parentChannelId, serverId, name, creatorId, parentMessageId?, pluginId? }` | a thread is opened under a text channel (from a message) or a forum (a post) |
| `event:created` / `event:updated` / `event:cancelled` / `event:started` / `event:ended` | `{ eventId, serverId, title, startsAt, endsAt, status }` | scheduled-event lifecycle (`status`: `scheduled` / `live` / `done` / `cancelled`) |
| `voice:runtime_initialized` / `voice:runtime_closed` | `{ channelId }` | a server voice channel's media router is created / destroyed |

`message:*` events are **not** emitted for end-to-end-encrypted messages, and no event covers DMs. A bridge that mirrors chat in both directions skips its own echoes by checking `pluginId` (or by looking up the `externalId` it posted with).

### `actions.messages`

Posting goes down the same road as an inbound webhook message: stored under the plugin's account, auto-moderated with that account as the accountable user, fanned out like a user message, and the persona (`author`) shown to readers. Voice channels, forum channels (post into a forum thread instead) and end-to-end-encrypted channels are refused with `BAD_REQUEST`.

`post({ channelId, content, author?, replyToId?, attachments?, externalId?, metadata? })` → `{ messageId }`

```typescript
const { messageId } = await ctx.actions.messages.post({
  channelId: 12,
  content: "deploy finished",
  author: { name: "CI", avatarUrl: "/public/ci-avatar.png" },
  externalId: "ci-run-8812", // posting it again returns the same messageId
});
```

- `content` ≤ the shared message cap (16 000); may be empty when `attachments` are given.
- `author.name` ≤ 80 chars; `author.avatarUrl` is a `/public/<file>` path (what `files.upload` returns as `url`) or an absolute `http(s)` URL.
- `replyToId` must be a message of the same channel.
- `attachments` ≤ 10 `{ fileId }` of files this plugin uploaded (`files.upload`).
- `externalId` ≤ 256 chars, unique per plugin, may not start with `__`. Re-posting it returns the existing message (idempotent re-delivery). Every post gets a link row, so `edit` / `delete` / `react` always work on your own posts by `messageId` too.
- `metadata` (SDK 0.4) is structured card state for the client — plain JSON, ≤ 16 top-level keys, ≤ 8 KiB serialised. It is stored next to the message (one entry per plugin in the message's `metadata` column, next to link previews), never rendered as text, and travels with the ordinary message fan-out; the client renders the cards it knows. The official watch-together plugin keeps its text-channel session on the card this way (`metadata.watch`), so every control is one `edit` and late readers just read the card. Keep a text `content` as well: it is what search, notifications and clients without the card show.

`edit({ messageId | externalId, content?, metadata? })` (at least one), `delete({ messageId | externalId })`, `react({ messageId | externalId, emoji, remove? })`

- `edit({ metadata })` replaces the plugin's card state whole and keeps the text; such an edit is not marked "(edited)" and emits no `message:updated` — nothing a bridge would mirror changed. `edit({ content })` is the familiar text edit (auto-moderated, mentions re-parsed, `message:updated` emitted); give both to change both at once.

`delete` leaves a tombstone ("Message deleted", attributed to the plugin's actor) rather than removing the row: content, attachments, reactions and the link row go at once, so the same `externalId` may be posted again, while `edit` / `react` / a second `delete` on it are `NOT_FOUND` and a `post` replying to it is `BAD_REQUEST`.

```typescript
await ctx.actions.messages.edit({ externalId: "ci-run-8812", content: "deploy finished (2 warnings)" });
await ctx.actions.messages.react({ externalId: "ci-run-8812", emoji: "✅" });
await ctx.actions.messages.react({ externalId: "ci-run-8812", emoji: "✅", remove: true });
await ctx.actions.messages.delete({ externalId: "ci-run-8812" });
```

- Scoped to messages the plugin posted → `FORBIDDEN` on anyone else's, unless the manifest declares `capabilities: ["moderate-messages"]`.
- `react` is explicit add/remove (not a toggle), idempotent, and the reaction is stored under the plugin's account. `emoji` is a unicode emoji or a `:custom_name:` token, ≤ 64 chars.
- Edits run auto-moderation again and re-parse mentions; a `message:updated` / `message:deleted` / `message:reaction` event follows with `pluginId` set.

### `actions.channels`

`list(serverId)` → `TPluginChannel[]` — `{ id, publicId, serverId, name, type, categoryId, parentChannelId, topic, private, e2ee, archived, position }` for every channel and thread of the server (≤ 2000).

`create({ serverId, name, type: "TEXT" | "VOICE", categoryId?, topic? })` → `TPluginChannel`

```typescript
const feed = await ctx.actions.channels.create({
  serverId: 1,
  name: "release-feed",   // ≤ 24 chars
  type: "TEXT",
  topic: "mirrored from the release tracker", // ≤ 128 chars
});
```

Appends to the category (the server's first one when omitted), publishes it to every member's sidebar, logs the activity under the plugin's account; a `VOICE` channel gets its media runtime at once.

`createThread({ channelId, parentMessageId?, name })` → `TPluginChannel`

```typescript
const thread = await ctx.actions.channels.createThread({
  channelId: feed.id,
  parentMessageId: messageId, // optional: start the thread from that message
  name: "v1.4.0 discussion",   // ≤ 100 chars
});
await ctx.actions.messages.post({ channelId: thread.id, content: "first!" });
```

The parent must be a `TEXT` or `FORUM` channel; a private parent's visibility overrides are copied; a message that already has a thread is `CONFLICT`. Emits `thread:created` with `pluginId`.

### `actions.members`

`list(serverId)` → `TPluginMember[]` — `{ id, publicId, name, nickname?, avatarUrl?, roles: { id, name }[] }`, at most 5000 members, roles limited to that server's. No e-mail, no auth identity, no federation home.

```typescript
const members = await ctx.actions.members.list(serverId);
const raiders = members.filter((m) => m.roles.some((r) => r.name === "Raider"));
ctx.log(`${raiders.length} raiders`);
```

### `actions.files`

`upload({ bytes | url, filename, mime?, serverId? })` → `TPluginFileRef` — `{ id, name, originalName, url, size, mimeType }`

```typescript
const file = await ctx.actions.files.upload({
  url: "https://cdn.example/images/patch-notes.png", // fetched through the hardened client
  filename: "patch-notes.png",
});
await ctx.actions.messages.post({ channelId, content: "", attachments: [{ fileId: file.id }] });
```

- Exactly one of `bytes` (`Uint8Array` / `ArrayBuffer`) or `url` (`http(s)` only).
- Same gates as the upload route: uploads enabled, size ≤ the instance's max file size, extension not in the blocked list (`.html`, `.svg`, `.js`, `.exe`, …), quota room for the plugin's account. `mime` picks an extension when `filename` has none.
- A URL is fetched with SSRF validation and DNS pinning, redirects refused, and the body capped at the max file size.
- The file is stored under the plugin's account; attach it to a message within five minutes or the orphan sweep removes it. `url` in the result is `/public/<name>` — usable as `author.avatarUrl`.

### `actions.events`

Scheduled events (the Planner). `UNAVAILABLE` on a server without the scheduler; `FORBIDDEN` when the community has the Planner switched off.

`create({ serverId, title, description?, gameTag?, startsAt, endsAt, hostId?, roles, maxParticipants?, announceChannelId? })` → `TPluginEvent` · `update(eventId, patch)` → `TPluginEvent` · `cancel(eventId)`

```typescript
const start = Date.now() + 2 * 3_600_000;
const raid = await ctx.actions.events.create({
  serverId: 1,
  title: "Tuesday raid",
  startsAt: start,
  endsAt: start + 3 * 3_600_000, // > startsAt, ≤ 24 h
  roles: [{ key: "tank", label: "Tank", cap: 2, color: "#60a5fa" }, { key: "dps", label: "DPS", cap: null, color: null }],
});
await ctx.actions.events.update(raid.id, { title: "Tuesday raid (moved)" });
```

Bounds: title ≤ 120, description ≤ 2000, gameTag ≤ 40, 1–12 roles (`key` ≤ 24, `label` ≤ 40, `cap` 1–200 or null, `color` `#rrggbb` or null), `maxParticipants` 1–500. `hostId` null (default) makes it a plugin-hosted event. The scheduler publishes to clients and emits `event:*` itself.

### `fetch(url, init?)` → `TPluginFetchResponse`

Outbound HTTP through the server's hardened client: `http(s)` only; private, link-local and loopback targets refused (operator allowlist aside); DNS pinned between validation and connect; redirects refused; a per-host outbound rate limit of 60 a minute in a budget of the plugin's own (another plugin or federation talking to the same host does not draw on it, nor you on theirs); body read through a cap. A refused request rejects with `BAD_REQUEST` and a message naming the host; wait a second and retry.

```typescript
const res = await ctx.fetch("https://api.example/v1/status", {
  method: "GET",
  headers: { Authorization: `Bearer ${settings.get("token")}` },
  timeoutMs: 5_000, // default 10 s, max 60 s
  maxBytes: 256 * 1024, // default 1 MiB, max 64 MiB
});
if (res.ok) ctx.log(await res.json());
```

`init`: `method` (upper-case verb), `headers` (≤ 64), `body` (string or bytes, ≤ 16 MiB), `timeoutMs`, `maxBytes`. The response exposes `ok`, `status`, `statusText`, `headers` (plain object), `bytes()`, `text()`, `json()`. The runtime's global `fetch` is still reachable from plugin code but **unsupported**: it bypasses every protection above.

### `http.register(path, handler)`

Serve `GET` and `POST /plugins/<pluginId>/<path>` from the server's HTTP port.

```typescript
ctx.http.register("webhook", async ({ method, body, query, headers }) => {
  if (method !== "POST") return { status: 405 };
  await ctx.actions.messages.post({ channelId: 12, content: `event: ${(body as { kind: string }).kind}` });
  return { status: 202, body: { accepted: true } };
});
```

- Every request must carry the plugin's secret in the `x-pulse-plugin-secret` header, or it is refused with 401. The secret is minted the first time the plugin registers a route, persists across restarts, and the instance owner reads it from the plugin's settings (`httpSecret` on `plugins.getSettings`). Paste it into the external service that calls you.
- `path`: 1–128 chars of `[a-zA-Z0-9._-]` segments (no `..`); leading/trailing slashes are dropped. At most 32 routes per plugin; registering a path again replaces the handler. Routes are removed on unload.
- The handler receives `{ method, path, headers, query, body }` — `body` is parsed JSON for `application/json`, the raw text otherwise, `null` on GET; the secret header is removed from `headers`. Bodies over 1 MiB are refused with 413.
- Return `{ status, body?, headers? }`: a string body is sent as `text/plain`, anything else as JSON, no body sends nothing. Framing and security headers you set are dropped. A thrown handler answers 500 and the error goes to the plugin log; a handler that takes longer than 30 s is cut off.
- Requests are rate limited per source address (120/min per plugin) and per plugin (600/min).

### `server.notify(topic, payload?)`

A one-way, in-process signal to the server. Server features that know your plugin subscribe to a topic by plugin id (`pluginManager.onNotify(pluginId, topic, handler)` on the server side) and act the moment you call it; a topic nobody listens to is dropped with a debug line in your log. The official bridge uses `bridge:sync-requested` with `{ serverId, requested }` to have a remote channel change paired at once instead of on the next minute tick.

```typescript
ctx.server.notify("bridge:sync-requested", { serverId: 1, requested: 3 });
```

- `topic`: 1–64 characters. `payload`: anything that serialises to JSON of at most 16 KiB (omit it for none). Out of bounds throws a `BAD_REQUEST` action error synchronously.
- Nothing comes back. A handler that fails is logged under your plugin's log; a call made from an instance of your plugin that has since been unloaded (a timer you forgot to clear) is ignored.

### `commands.register(command)`

Registers a slash command users can invoke from the composer.

```typescript
ctx.commands.register({
  name: "greet",
  description: "Greet a user",
  args: [{ name: "username", type: "string", description: "Who to greet", required: true, sensitive: false }],
  async executes(invoker: TInvokerContext, args: { username: string }) {
    return `Hello, ${args.username}!`;
  },
});
```

- `args[].type` is `"string" | "number" | "boolean"`; `sensitive: true` masks the value in the UI and in logs. Typed from the composer, arguments are positional (`/greet Alice`) and quoted when they hold spaces (`/greet "Alice B"`).
- `executes(invoker, args)` receives `{ userId, currentVoiceChannelId?, activeServerId?, canModerate?, channelId?, subcommand? }` — the server the command was run from, whether the invoker holds MANAGE_USERS there, and the text channel (or thread) whose composer the command was typed into (`channelId` is absent when it came through `plugins.executeCommand`: a button, the voice popover) (SDK 0.4; absent on older servers) — and whatever it returns is shown to the invoker.
- Registering a name twice overwrites the first registration (and logs an error).

**Sub-commands and choices (SDK 0.4.0).** A command that does several things declares them as `subcommands`, each with its own `args`; the composer then lists the verbs after `/name ` and the arguments of the one picked, so nobody has to guess what the command takes:

```typescript
ctx.commands.register({
  name: "watch",
  description: "Watch a video together",
  subcommands: [
    { name: "play", description: "Play a link, or resume", args: [{ name: "link", type: "string", placeholder: "YouTube link, .mp4, .m3u8" }] },
    { name: "pause", description: "Pause for everyone" },
    { name: "seek", description: "Jump to a position", args: [{ name: "seconds", type: "number", required: true }] },
    { name: "quality", args: [{ name: "level", type: "string", required: true, choices: [{ value: "auto" }, { value: "720", label: "720p" }] }] },
    { name: "watching", hidden: true, args: [{ name: "channelId", type: "number" }] },
  ],
  async executes(invoker, args: { link?: string; seconds?: number; level?: string }) {
    switch (invoker.subcommand) {
      case "play": /* args.link */ break;
      case "seek": /* args.seconds */ break;
      // …
    }
  },
});
```

- `/watch seek 90` reaches `executes` with `invoker.subcommand === "seek"` and `args === { seconds: 90 }`; the sub-command's `args` are read positionally after the verb. Over `plugins.executeCommand` a client passes `{ commandName: "watch", subcommand: "seek", args: { seconds: 90 } }`.
- `/watch` on its own runs the command with its own `args` when it declares any (the first token is then read as before — a plugin that accepted `/watch <address>` positionally keeps accepting it), else the reply is the generated usage (`Usage: /watch <play | pause | seek | quality>` with one line per verb). A first token that names no sub-command is treated the same way.
- `hidden: true` keeps a sub-command out of the composer's list and the usage while leaving it callable (a client reporting state through the command).
- `choices` on an argument are listed in the composer while that argument is typed (`value` is inserted; `label` and `description` are what the row reads); `placeholder` stands in for the name in the usage hint. The composer never completes an argument that has no choices.
- Bounds, checked when the command is registered (a violation is the plugin's load error): at most 20 sub-commands, 8 arguments per sub-command, 32 choices per argument, sub-command and argument names `[a-z0-9-]{1,32}`.
- `plugins.getCommands` and `onCommandsChange` carry `subcommands` (hidden ones left out), `choices`, `placeholder` and the plugin's `logo`. A plugin without sub-commands is listed exactly as before.

### `settings.register(definitions)` → `Promise<PluginSettings>`

Declares typed, admin-editable settings. Each definition is `{ key, name, description?, type: "string" | "number" | "boolean" | "secret", defaultValue }`. Values persist in the database, merge over the defaults on every load, and admins change them from the panel (`plugins.updateSetting` / `plugins.getSettings`). Keys starting with `__` are reserved for the loader.

The returned object has `get(key)` and `set(key, value)`; `set` persists asynchronously and logs an error for an unregistered key. Pass the definitions `as const` to get typed `get`/`set`.

**`secret`** is for tokens and keys. The server stores the value encrypted under the instance's file-signing secret and never returns it: `plugins.getSettings` reports `{ set: boolean }`, the panel shows a masked write-only field ("Set" / "Replace"), `plugins.updateSetting` takes a new value or `null` to clear it, and `get(key)` hands your plugin the plaintext (an empty string while unset). `defaultValue` is `""`. If a setting you shipped as `string` becomes `secret`, the value already stored is encrypted on the next load and the plaintext row replaced. Keep the plaintext out of your logs; the loader never logs it.

### `actions.voice`

- `getRouter(channelId)` — the mediasoup `Router` of a **server** voice channel runtime (DM calls are not addressable). Throws if no runtime exists for the id.
- `createStream({ channelId, title, key, avatarUrl?, producers: { audio?, video? }, media? })` — publishes an external stream into the channel; it appears in the roster as a synthetic participant and every member gets the new producers announced. The producers must be created on that channel's router (typically via a `PlainTransport` you open yourself). Returns `{ streamId, remove(), update({ title?, avatarUrl?, producers?, media? }) }`.
- `media` (SDK 0.4) is the other way to put something on screen: `{ url, kind: "file" | "hls" | "youtube", videoId?, playing, position, updatedAt, hostUserId }`. The server has no decoder and never touches the address — every client in the room plays it itself and follows the transport state, deriving the live position as `position + (now - updatedAt) / 1000` while `playing`. A `youtube` descriptor (`videoId` = the 11-character id, `url` = the canonical watch address) is played through that site's own embedded player, driven by the same position math. Keep the descriptor current through `update({ media })` on every play, pause and seek (one fan-out each); `update({ media: null })` takes it down without removing the stream. The official `watch-together` plugin is the reference.
- `getListenInfo()` — `{ ip, announcedAddress }` the server's own WebRTC transports use, so your `PlainTransport` advertises the same address.

The SDK re-exports the mediasoup types you need for this (`Router`, `Producer`, `PlainTransport`, `RtpParameters`, …).

## Best practices

1. **Handle errors** — check `isPluginActionError(error)` and its `code`; an unhandled rejection inside a handler is logged but can leave your plugin in a half-initialised state.
2. **Clean up** in `onUnload`: close sockets, timers and transports you opened (routes, listeners, commands and settings are removed for you).
3. **Never block the event loop** (no `Bun.spawnSync`, no long synchronous loops) — the server is single-threaded and voice runs in the same process.
4. **Use `ctx.fetch`**, not the global `fetch`, for anything that reaches the network.
5. **Use `externalId`** on every post you might deliver twice, and skip `message:*` events whose `pluginId` is yours.
6. **Declare `pulse.sdk`** and bump the range when you adopt a new SDK version; declare only the `capabilities` you need.
7. **Validate command arguments** before using them.

## License

This SDK is part of the Pulse project. See the main repository for license information.
