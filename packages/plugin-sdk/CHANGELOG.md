# @pulse/plugin-sdk changelog

## 0.3.0 — 2026-10-16

Nothing removed. A plugin that declares `"sdk": "^0.1"` or `"^0.2"` keeps loading on a 0.3 server.

### Added — settings

- Setting type `secret` (`{ key, name, description?, type: "secret", defaultValue: "" }`). The server stores the value encrypted under the instance's file-signing secret; `settings.get(key)` returns the plaintext to the plugin only; `plugins.getSettings` reports `{ set: boolean }` and never the value; `plugins.updateSetting` takes a new value or `null` to clear it. The settings panel shows a masked write-only field ("Set" / "Replace").
- A value stored in the clear before a setting became `secret` is encrypted on the plugin's first load after the change and the plaintext row is replaced (the official bridge's bot token went through this).

### Added — `PluginContext`

- `server.notify(topic, payload?)` — a one-way, in-process signal to the server. Server features subscribe per plugin id and topic (`pluginManager.onNotify`) and act at once; the bridge's `bridge:sync-requested` is the first. Topic ≤ 64 chars, payload ≤ 16 KiB as JSON (`BAD_REQUEST` otherwise); a call from an unloaded plugin instance is dropped.
- `fetch` now draws on the plugin's **own** per-host budget (60 a minute per host, per plugin) instead of the one federation shares.

### Added — loader

- Hot reload on toggle: when a plugin is switched on and its entry file changed since it was last loaded in this process, the new file runs (the loader imports a copy under `<plugin dir>/.runtime/`; older copies are removed). Only the entry file is copied, so ship one bundled file — a relative import inside the entry does not resolve from the copy.
- `pluginManager.onPluginLoaded(listener)` / `onPluginUnloaded(listener)` for server-side features that react to a plugin coming and going (the bridge syncs every server link when it loads).

## 0.2.0 — 2026-10-16

Nothing removed. A plugin that declares `"sdk": "^0.1"` keeps loading on a 0.2 server (the loader treats every range that admits 0.1.x as compatible, because 0.2 is a strict superset).

### Added — `PluginContext`

- `actions.messages.post({ channelId, content, author?, replyToId?, attachments?, externalId? })` → `{ messageId }`. Posts under the instance owner's account with an optional display persona, runs auto-moderation, fans out like a user message. Refuses voice, forum and end-to-end-encrypted channels. `externalId` is idempotent per plugin.
- `actions.messages.edit`, `.delete`, `.react` — by `messageId` or `externalId`; scoped to the plugin's own posts unless the manifest declares `capabilities: ["moderate-messages"]`.
- `actions.channels.list(serverId)`, `.create({ serverId, name, type, categoryId?, topic? })`, `.createThread({ channelId, parentMessageId?, name })`.
- `actions.members.list(serverId)` → `{ id, publicId, name, nickname?, avatarUrl?, roles: { id, name }[] }[]` (≤ 5000; no e-mail, no identities).
- `actions.files.upload({ bytes | url, filename, mime?, serverId? })` → `TPluginFileRef`; URLs are fetched through the hardened client under the instance upload limits.
- `actions.events.create / update / cancel` — scheduled events (raid planner); `UNAVAILABLE` on a server without the scheduler.
- `fetch(url, init?)` — outbound HTTP through the hardened client (SSRF checks, DNS pinning, no redirects, per-host rate limit, bounded body).
- `http.register(path, handler)` — `GET`/`POST /plugins/<pluginId>/<path>`, guarded by the per-plugin secret header `x-pulse-plugin-secret`, 1 MiB body cap, rate limited.

### Added — events

- `message:reaction` `{ messageId, channelId, userId, emoji, added, pluginId? }`
- `thread:created` `{ threadId, parentChannelId, serverId, name, creatorId, parentMessageId?, pluginId? }`
- `member:roles_changed` `{ userId, serverId, roleIds }`
- `event:created | event:updated | event:cancelled | event:started | event:ended` `{ eventId, serverId, title, startsAt, endsAt, status }`
- `message:created` / `message:updated` gain an optional `pluginId` (set when a plugin posted the message).

### Added — manifest and types

- `pulse.capabilities` in package.json (`TPluginCapability`); `TPluginInfo.capabilities`.
- `TPluginActionError` + `isPluginActionError()`: every `actions.*` rejection carries a `code` (`BAD_REQUEST | NOT_FOUND | FORBIDDEN | CONFLICT | UNAVAILABLE`).
- `TPluginSettingsResponse.httpSecret` on the instance owner's settings route.

## 0.1.0

Initial release: `events.on`, `commands.register`, `settings.register`, `actions.voice.*`, `pulse.sdk` range gate.
