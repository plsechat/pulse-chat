# discord-bridge

An official PULSE plugin that mirrors a text channel with a channel on a Discord server, both ways: messages, edits, deletions, reactions, threads and scheduled events. Each side shows the other's authors by name and avatar. Voice is not bridged.

It ships inside the PULSE image under the data directory's `plugins/` folder and is **off by default**. It is written against the plugin SDK 0.2 only — no server internals.

## Setting it up

1. **Create a bot** in the developer portal of the other service: an application with a bot user. Under the bot's settings switch on the two privileged intents, **Server Members** and **Message Content** — without the second every message arrives empty.
2. **Add the bot to the server(s)** you want to bridge with these permissions: View Channels, Read Message History, Send Messages, Manage Webhooks, Manage Messages, Manage Threads, Create Public Threads, Send Messages in Threads, Add Reactions, Manage Events.
3. **Enable the plugin** as the instance owner: Server Settings → Instance → Plugins → `discord-bridge` → switch it on, then open its settings and paste the **Bot token**. Set the **Public address** of the instance (for example `https://chat.example.com`) so member avatars and attachment links resolve on the other side. The token is picked up within 15 seconds; no reload needed.
4. **Link a channel**: Channel Settings → Bridge (needs Manage Channels; the tab appears only while the plugin runs). Pick the server and the channel the bot can see, choose a direction (both ways / only from there / only from here) and link. The plugin creates a webhook on the remote channel; messages written here are posted through it under the author's name and avatar.

Threads under a bridged channel follow it automatically. Scheduled events of a server are mirrored to the first linked remote server and back.

## What is refused

- **End-to-end encrypted channels** cannot be linked: the server cannot read their messages, so it cannot mirror them. The tab says so.
- **Voice** and **forum** channels cannot be linked (no text; posts rather than messages).

## Where secrets live — read this

- The **bot token** is a plugin setting. The SDK's settings store keeps settings as plain JSON in the server's `plugin_data` table: **the token is not encrypted at rest**. Only the instance owner can read it back (the plugin settings route), but anyone with the database has it. Treat the database accordingly, and rotate the token in the developer portal if in doubt.
- The **webhook tokens** the plugin creates are stored by the server encrypted (`bridge_links.webhook_token_ciphertext`, under the instance's file-signing secret) and never returned by any route. The plugin keeps them in memory only; after a restart it reads them back through the bot (`GET /webhooks/{id}`).
- The plugin's own state file (`bridge-state.json` next to the plugin) holds the link list and the message id map — no secret.

## How it stays loop-free

- A message the plugin posts here carries the plugin's id on its `message:*` events and is skipped on the way out.
- A message the plugin sends through a webhook comes back on the gateway with that webhook's id and is skipped on the way in; the bot's own reactions, threads and events come back under the bot's user id and are skipped the same way.
- A deletion is applied to the map before the other side is told, so the echo finds nothing to mirror.
- A scheduled event applied from the other side is written inside a guard that mutes the outbound handler, and the plugin remembers the last state it pushed so the echo of its own update is recognised.

## Limits and bounds

- The server's outbound client allows 60 requests per minute per host for plugins. The bridge keeps its own copy of that budget (a step under it), honours the API's per-route rate-limit headers and 429 `retry_after`, backs off on 5xx, and sends one request at a time in order. A burst of messages queues; it does not fail.
- Message id map: 50 000 pairs (oldest evicted); threads 5 000; events 2 000; remembered author personas 10 000.
- Inbound attachments: up to 10 per message, re-hosted through the server's file pipeline (same size and extension rules as uploads); one that cannot be re-hosted is named in the text. Outbound attachments are sent as links once the server's `message:created` event carries them (read optionally today).
- Inbound content follows the community import's rules (mentions, custom emoji, timestamps, embeds, stickers); outbound content is the composer's HTML turned into text with mentions resolved and **no pings** over there (`allowed_mentions: none`). A remote `@here` stays `@here` here.
- The gateway uses the runtime's WebSocket directly (the SDK has no socket API); it dials only `gateway.discord.gg` and resume URLs under `discord.gg`. REST goes through `ctx.fetch` (SSRF-hardened) to one fixed origin.

## Status

Channel Settings → Bridge shows: connected as which bot (or why not), the link, the direction, how many messages were mirrored since midnight UTC, and the last error for that link.

## Development

```
cd packages/plugins/discord-bridge
bun test src            # unit tests over recorded gateway/REST fixtures — no network
bun run check-types && bun run lint
bun run build           # dist/index.js (what the image ships)
```

To run it on a dev server, build and copy `package.json` + `dist/` into `apps/server/data/plugins/discord-bridge/`, then enable it from Instance → Plugins. The server loads `dist/index.js`; the SDK types are type-only, so the built file has no runtime dependency on the monorepo.
