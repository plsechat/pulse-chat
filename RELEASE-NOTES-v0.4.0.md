# Pulse Chat v0.4.0: a new layout, communities that reach each other, plugins that act, and the audit with nothing deferred

Released: TBD

## TL;DR

**New in this release beyond the audit:** a new **layout** (communities as tabs, side panels for friends, messages, inbox and profile) with a redesigned visual system; a **Raid Planner** app in every community (rosters, reminders, an automatic voice room, a calendar feed); a **community import** wizard that brings channels, roles, emoji, history and attachments over from another chat service; and **plugin SDK 0.4**, which lets plugins post, edit and react to messages, create channels, upload files, keep secrets and serve HTTP endpoints, acting under an account of their own; an official **chat bridge** plugin that mirrors a whole community to a server on another chat service in both directions; **announcement channels, polls and scheduled posts**, with announcement channels you can **follow** from another community, even on a federated instance; a **public directory** of communities across the federation; **deleted messages leave a placeholder** instead of vanishing; a **soundboard** for voice rooms and a **watch-together** plugin for text channels and voice rooms; and **game presence** with the desktop app.


Every subsystem was audited end to end — HTTP edge, authorization, federation, end-to-end encryption, voice, data layer, client state, UI, CI and tests — and everything the audit found was fixed in this release, nothing deferred. Headlines: **sessions can be revoked** and private **file links expire**; **roles have a real hierarchy**; **plugins actually load** and have a panel; federation gets **pinned fetches, a durable relay outbox and key rotation**; E2EE no longer **shows stale text after an edit** or **loses sender keys for late joiners**; voice runs on **one media port** with **instance-wide capacity** and no more cross-talk between DM calls and channels; the client keeps **one live socket** and routes home actions home; the app is **usable on a phone**; and the initial download is **less than half the size**. There are a few one-time effects on upgrade — read the Upgrading section.

---

## Headline features

### New layout and look

- **Communities as tabs** across the top, with back and forward over the tabs you visited, drag to reorder, and a plus menu to open any of your communities. Friends, Messages, Inbox and Profile open as resizable panels on the right. The community rail is not shown in this layout, since the tabs already list every open community. Its Home tab is an overview: recent conversations with their last message and unread count, friends who are around, every community with its unread and mention counts, your inbox, the week's upcoming events across your communities, and who is playing what; each row opens the matching panel or community. It is the default now on screens 768 px and wider; Appearance → Layout → **Traditional layout** brings the rail back. Phones use their own layout either way.
- **A night palette with depth**: canvas, a raised channel pane and the content pane as three layers; squircle avatars; a contained composer with a formatting bar; relative timestamps; mentions of you get a warm wash. Every theme, including Onyx and the light themes, received the new tokens. The shell tint on tabs, headers and the active channel is the theme's own primary colour, so it follows every theme; communities are told apart by logo and initial. Your avatar in the top-right tray opens your account settings from any tab; voice and status controls stay on the bottom-left card.

### Raid Planner

- An **Apps** section in each community's channel list opens the planner: a month grid and an agenda, event sheets with **role rosters** (templates, caps, a bench that auto-promotes, change role, withdraw, decline), host controls to bench and promote, RSVP cards in the announce channel, and roster **templates** under Server Settings → Events. Creating and managing events needs the new **Manage events** permission.
- **Reminders** at 24 hours, 1 hour and start (toast and desktop notification). Fifteen minutes before start a **private voice room** appears for the signed-up members and host; fifteen minutes after the scheduled end it is removed, whoever is still in it, and a summary is posted.
- **Subscribe** copies a calendar-feed link you can add to any calendar app; the link stops working when you leave the community. The feed refreshes at once after a change and asks calendar apps to poll every 15 minutes; the subscribe button explains Apple Calendar's own schedule and the "On My Mac" location for addresses the internet cannot reach.

### Community import

- Server owners get **Server Settings → Integrations → Import**: connect a bot, pick the community, preview what will come over (with warnings and a time estimate), choose history depth, attachments, members and roles, then watch it run with pause, resume, cancel and retry. Categories, channels, roles, emoji, pins, threads, history, attachments and scheduled events all come across; progress survives a restart.
- Imported authors are **placeholders** until the real person signs in through the matching provider with the same account, at which point their history moves to them automatically. **Imported people** under the wizard lets an admin link a placeholder to a member by hand (one way, the same merge); roles and membership carry over either way.
- Bot status cards (title, description, fields, footer) and picker GIFs are imported instead of arriving empty; skipped messages are explained (notices, empty, unreadable channels). A thread removed while the import runs is created again instead of failing the job, and the empty-thread sweep leaves communities with an import in flight alone. Importing the same community again reuses what the first run created.

### Chat bridge

- An official bridge plugin ships in the image, off by default. Enable it under Instance → Plugins, give it a bot token, and link your **whole community** to a server on the other side from Server Settings → Integrations → Bridge: channels pair by name, or get created where missing on either side with their categories, new channels on either side follow automatically, and deletions are never mirrored. Each channel's own **Bridge** tab can opt out, set its own direction, or link a channel by hand. Messages, edits, deletions, reactions, threads and scheduled events flow both ways, and each side shows the other's authors by name and avatar. Encrypted channels cannot be bridged. Voice is not bridged. Status-bot cards and their edits arrive as text, GIFs from the picker arrive as attachments, and a channel created or removed on the other side, or a bot reconnect, pairs at once; the outcome of the last sync is kept and shown after a restart.
- Plugins post under their **own account** instead of the instance owner's (labelled "Plugin" in the member list), so the owner gets sounds, notifications and unread markers for bridged messages like everyone else.

### Plugin SDK 0.4

- Plugins can now **post, edit, delete and react** to messages (with an external id so a mirrored message is never posted twice), **create channels and threads**, **list members**, **upload files**, make hardened outbound requests, register signed **HTTP endpoints**, create and update **scheduled events**, and subscribe to reactions, threads, role changes and scheduled events. Plugins declared against an earlier 0.x range keep loading; every 0.x minor is a superset of the one before.
- **Secret settings** are stored encrypted and never shown again (the bridge's bot token is one); plugins can **signal the server** in-process (`server.notify`), hook their own load and unload on the server side, and updated plugin files load on toggle without a restart. Messages can carry **structured card state** (post and edit with `metadata`), external streams can carry a **shared-playback descriptor**, and commands learn which community and channel they were run from and whether the invoker can moderate there.
- **Slash commands you can see.** Typing `/` in a channel opens a command palette: each command with its plugin's logo, what it does and what it takes; typing `/watch ` lists its sub-commands (play, pause, seek, stop, status) to pick with the arrow keys, and a hint above the composer shows the usage of what you are typing with the current argument marked. Plugins declare sub-commands and argument choices (`subcommands`, `choices`, `placeholder`, `hidden`); the old positional spellings keep working. A member's command reads as a small "used /watch pause" line in their row instead of a message, with the reply beneath it; a refused command says why, on the line and as a toast to the person who typed it.

### Announcements, polls and scheduled posts

- **Announcement channels** (a switch on a text channel) only holders of the new **Post announcements** permission can post in, with everyone reading; **polls** from the composer's plus menu (2 to 10 options, single or multiple choice, anonymous, with a closing time between a minute and 30 days away, and live results); **scheduled posts** with a Scheduled panel in the header to review and cancel them.
- **Follow** an announcement channel from another community on this instance or on a federated peer (Channel Settings → Follows): posts, edits and deletions arrive as announcement cards in the following channel.

### Public directory

- Communities can **list themselves** with a description, tags and a game (Server Settings → General); members browse and search listings from this instance and its federated peers under Discover → Directory and join from the card. Instance owners can keep their directory private to peers under Instance → Registration.

### Soundboard and watch-together

- A **soundboard** for voice rooms: members with the new **Manage sounds** permission upload short clips (up to 5 seconds and 512 KB, 50 per community) under Server Settings → Sounds, with an emoji and a level; anyone with the **Use the soundboard** permission plays them with a tap from the call controls, favourites first. The player's tile ripples with the clip's name; deafened members hear nothing and a moderator-muted member cannot trigger one. Clips are paced: one per person every 2 seconds, ten per room per minute.
- A **watch-together** plugin (official, off by default). Type `/watch play <link>` into any text channel and a watch card appears there: a YouTube link (watch, youtu.be, Shorts, embed or live), a video file or an HLS stream, with its title, who started it, whether it plays and how far it is. Anyone reading the channel presses **Watch** and gets the synced player (a side panel in the tab layout, a dialog in the traditional one) at the same position as everyone else, with their own volume, deafen muting it, and **Catch up** if their browser held playback; the starter and the moderators share play, pause, seek and stop from the player or by typing `/watch pause` in the channel. One live card per channel; it ends on `/watch stop`, when a new link replaces it, or when nobody has had it open for ten minutes, and the card stays in the channel as history. Voice rooms are the other way: the Watch together button in the call controls plays for the room through a stream card. YouTube plays through the site's own embedded player; a private or non-embeddable video is refused up front; other video sites are not resolved, and the command says so.

### Game presence

- With the desktop app, **share what you're playing** (off by default, with a per-community opt-out under User Settings → Privacy) and see who's playing what: "Playing …" under names in the member list, "for N min" on profile cards, and a "Now playing" section at the top of the members pane. Works across federated communities. Presence clears on sign-out and after six hours at most.

### Deleted messages leave a placeholder

- Deleting a message no longer makes it vanish: the row stays in place as an italic *Message deleted* placeholder with its text, attachments, reactions, link previews and pin removed at once, so replies still point at something, threads keep their root and deep links still land. Holders of Manage messages also see who deleted it and when. This covers channel messages, DMs (encrypted ones too), bulk moderation, report takedowns, plugin deletions and the copies in following channels; clearing a whole channel still removes everything. Placeholders age out after `server.tombstoneRetentionDays` (default 30). Deleted messages never count as unread, never appear in search or pinned lists, and cannot be edited, reacted to, pinned, forwarded, replied to or turned into a thread.


### Phone-ready client

- Opaque channel and member **drawers** with swipe gestures that stay out of the way of code blocks, scrollers and menus; the platform **Back gesture closes** drawers, sheets, threads and the settings card instead of leaving the app.
- A header **overflow menu** with the channel topic, encryption status, Search, Pinned, Threads and notification settings as full-height sheets; **threads and forum posts open full-screen** with a Back arrow.
- A compact **in-call bar** under the header while in voice, and a floating tile for a pinned camera or screen share that stays usable while you type.
- The soft keyboard no longer pans the layout away; **Enter inserts a newline on touch keyboards** and the Send button sends. Hover-only controls (message actions, reactions, timestamps, upload overlays) show on touch. Popovers, embeds, settings panes and admin tables fit the viewport.
- Reloading while a federated server is in focus **returns you to that server**.

### Sessions you can end

- On the local auth backend, refresh tokens now form **revocable families**: logging out revokes the session server-side, **changing your password signs out every other device**, and a replayed old token kills the whole family. Access tokens live 15 minutes and renew quietly before every connect and upload.

### Private files that stop being reachable

- Attachment links in private channels and DMs are **signed with an expiry** (12 to 24 hours) and the channel **re-keys whenever someone loses access** — kick, ban, leave, role or override change, privacy flip, account deletion — so old links stop resolving at once. Uploaded audio and video now **seek** (HTTP Range), and public media caches properly.

### Roles with a hierarchy

- Every role has a **position**. You can only create, edit, assign, delete or reorder roles **below your own top role**, and only grant permissions you hold. The roles list reads highest-first with **drag-to-reorder** limited to what you may move. Leaving, being kicked or banned **strips your roles and overrides** for that server. Permission changes apply to live connections immediately.

### Plugins, for real

- The loader read a setting the UI never wrote, so plugins could not load before. They do now, and a **Plugins panel** lives under Server Settings → Instance for the instance owner; the per-community "Plugins" switch in General gates command execution in that community (on the instance owner's own community it is also what loads plugins at boot). The SDK gains `member:joined` / `member:left` events and a compatibility range enforced by the loader.

### Settings and admin

- **Upload limits** (allow uploads, max file size, per-member quota, overflow action) moved into General; the enforced limits are now the configured ones instead of seeded defaults.
- Server Settings opens for anyone who may see at least one section and lands on the first allowed one; moderators with only reports, webhooks or automod no longer get an empty page. Every instance panel shows a spinner, an inline error and **Retry**; Health pauses its polling while the tab is hidden.
- **Zoom and font scale for everyone** (dialogs stay inside the viewport), an **Onyx** theme that is true black, and **System** that follows the OS appearance live.
- **Group DM settings**: rename and upload an icon that every member sees.
- Auto-Mod gains a working **timeout action** (timed-out members cannot send or join voice, with a live chip in the member list) and alerts render as proper system notices with a "Review rules" link.
- A **retention** setting prunes login and activity history (default 90 days); account deletion scrubs everything it should; logs redact tokens and secrets before they reach any transport or the admin tail.

### Federation

- Allowlisted **IP-literal and localhost peers work again**; every outbound federation fetch is **DNS-pinned** and size-capped; link previews use an in-house pinned fetcher.
- A **durable relay outbox** persists every relay, retries per peer with backoff and dead-letters after eight attempts or 48 hours. The instance panel shows pending and undelivered counts, the peer version and a retry action; the server rail marks a degraded peer.
- **Presence reaches peers**, **key rotation** with a 24-hour grace, **unpeering** tells the other side and sweeps ghost DMs, and reports against a federated user are relayed to their home instance.
- An expired federation token now **re-mints and reconnects** instead of permanently dropping the connection. Shadow identities are keyed by home instance plus public id, so one remote user can no longer resolve as another; concurrent first contact yields one DM channel.

### End-to-end encryption

- The own-message plaintext cache is keyed by instance, kind and id and bound to its ciphertext: a channel, group-DM and federated message with the same id no longer collide, and an **edited sender-key message re-decrypts** instead of showing the old text forever.
- **Late joiners receive sender keys**, pending keys are pulled on every federated connect, a bad pairwise ciphertext no longer wipes the session, and **friends-only encrypted DMs can establish a session**.
- An identity reset silently re-pins trust-on-first-use peers but **prompts for a manually verified identity**; nothing is re-keyed until you accept.
- Threads and forum posts under an encrypted channel inherit encryption; the docs state the single-device contract and what the server can still see.

### Voice

- DM calls and server channels that share a numeric id no longer leak media or roster into each other; deleting a channel, DM or server, or leaving, **evicts everyone from the live call** cleanly.
- Media runs on **one port (40000 udp+tcp)** by default with an **instance-wide participant cap**; capacity problems answer "Voice capacity reached" instead of silently failing. Optional **TURN relay** configuration is documented.
- The server owner cannot be muted, deafened, disconnected, kicked or banned; **server-deafen is enforced at the SFU** and moderation overrides survive rejoin.
- Reconnecting **rejoins your voice session**; microphone and transport failures are surfaced instead of sending silence; a failed join no longer leaves a ghost participant.
- **Output device selection works**, plugin audio plays once, the incoming-call ring has its own toggle, and the quality ladder is clamped to the instance cap.
- Screen share keeps its frame rate at high quality: the encoder budget follows the chosen resolution and frame rate (about 3.5 Mbps for 1080p at 15, up to the 20 Mbps producer cap for 2160p at 60) instead of a flat 2.5 Mbps, a 30 or 60 fps share protects motion rather than text sharpness, and a "Share system audio" toggle lives under User Settings → Devices.

## Security & privacy

- **Uploads** are served under a sandboxing CSP, only images, video, audio and PDF inline, everything else as an attachment; intake pre-checks quotas, bounds names and sweeps leftovers at boot.
- **Edge**: rate limits key on ip and path with a capped store and now cover public files, webhooks and federation; trusted-proxy resolution is one helper with explicit opt-in for proxy headers; WebSocket connections are capped per IP and user; CSP drops `unsafe-eval` (the only scripts allowed beyond the app's own are the YouTube player API hosts the watch card needs); HSTS on https; CORS no longer breaks encrypted uploads to federated instances.
- **Authorization**: no active server means no permissions; search no longer returns private-channel messages; replies must reference the same channel; private channel rows and threads fan out only to viewers; overrides are evaluated on every channel; invite codes are consumed atomically and released on failure; a partial settings update no longer clears the server password; every router bounds its inputs.
- **Webhooks** validate their body, refuse encrypted and voice channels, run automod and never fetch an avatar URL.
- **Auth**: local-backend emails are case-insensitive, unknown emails take the same time as wrong passwords, password minimum is 8, OAuth providers are advertised only under the Supabase backend.
- **DMs**: the pin banner, search results and pinned list render through the same sanitized body as messages, so raw markup and unsanitized legacy HTML never reach the DOM. Searching an encrypted DM matches what your device has decrypted; the server only ever searches plaintext rows.
- **Client**: one live home socket; home actions (mark read, mute, notes, status) always go to the home instance; the remote instance's events no longer land in the home badge map; being removed from a group DM drops it at once.

## Fixes

- Channels no longer stay greyed out after switching back to them.
- A dialog opened right after another one closed (a confirmation reached from a popover, say) no longer disappears with the earlier one's fade.
- Right-clicking a link in a message shows the browser's own link menu (Copy Link Address, Open in New Tab); the desktop app and touch long-press get a "Copy Link" item in the message menu instead.
- Share links from other services whose path looked like a video id no longer render as a broken player.
- A person's avatar placeholder is the same colour everywhere (roster, DM list, reaction hover, permission overrides) and the same on every federated instance.
- Renaming a community or changing its description reaches every member live: sidebar header, tabs, rail, Discover and Directory cards.
- Edited messages, blockquotes, code fences and paragraphs after code blocks survive the editor round-trip intact.
- Search with a "has file" filter no longer fails; DM read state syncs across your sessions; paging back no longer regresses the read marker.
- Inter loads under the CSP (self-hosted); the Home button has a real accessible name; 57 icon-only buttons gained labels and a lint rule keeps it that way; the color swatch, sheet close and fullscreen image are keyboard-reachable.
- Hopping between voice channels plays only the join cue; own-voice flags reset on leave so the share icon does not stay lit.
- The tab title and desktop badge count unread across every server and DM; desktop-notification settings show the browser permission state.
- A failed queue job no longer discards every queued job; the server shuts down gracefully on SIGTERM; webhook avatars and group-DM icons are no longer deleted as orphans.

## Under the hood

- Initial JavaScript drops from one 5.5 MB chunk to about 2.2 MB across cacheable vendor chunks; pickers, settings, tweets, mediasoup, libsignal and supabase-js load on first use. Message lists are a 300-message window per channel.
- `@pulse/shared` is a standalone package; row-derived types are published by the server and imported type-only by the client.
- Routes run on scoped procedure builders; cross-server ids read as nonexistent rather than as a permission failure that confirms existence.
- Migrations 0029 through 0042 (removal of the updates permission, local-auth email normalisation, role positions, settings source of truth, integrity foreign keys and indexes, automod timeouts, local auth sessions, relay outbox, shadow identity and DM pair keys, events and plugin message links, import jobs and external identities, channel and whole-server bridge links, polls, scheduled posts, follows, sounds, the directory cache and game presence, message tombstones) apply automatically on boot. Locked crons take their advisory locks on a pool of their own, so a dozen of them starting at boot can no longer exhaust the main one.
- Tests: the server suite is green in one process, client unit tests exist (over 700 across about 100 files), every probe spec became a real test, a core-mobile Playwright project runs on a Pixel 7 profile, and a nightly upgrade smoke boots the previous published image and upgrades it on the same volumes.
- The Docker image runs unprivileged with a health check that follows the configured port and a stop signal; releases ship SHA256SUMS, provenance and SBOM attestations and require green CI on the commit.
- The never-working Updates feature was removed end to end.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Schema changes apply automatically on boot. What to expect once:

- **Local auth backend: everyone signs in once.** Tokens minted before this release carry no session family and are rejected.
- **Safety numbers change once** for everyone (they now hash stable public ids, so a federated pair sees identical digits). Pins and verification status are untouched.
- **Private attachment links expire** after 12 to 24 hours; anything you copied out of the app stops working after that.
- **Voice networking** defaults to a single port 40000 (udp and tcp). An existing `40000-40020` mapping keeps working; set `MEDIASOUP_MODE=range` to restore the old range behaviour.
- **Federation wire changes**: `/federation/servers` is a signed POST, `/federation/user-info` is public-id only with a signed response, and `/federation/accept` verifies the full body (the old domain-only signature is still accepted this release). New endpoints: `/unpeer`, `/key-rotation`, `/report-user`, `/directory`, `/announcement-follow`, `/announcement`. Peers on the previous release still bootstrap against this one; see docs/federation.md "Version compatibility".
- **API rename with a one-release alias**: `others.joinServer` → `others.openSession`, `servers.join` → `servers.joinByInvite`, `users.onJoin` → `users.onConnected` (event `USER_CONNECTED`); becoming a member is `SERVER_MEMBER_JOIN` to every member. Plugin events: `user:joined` → `user:connected`, `user:left` → `member:left`, new `member:joined`. The old names keep working in v0.4.0 and are removed in v0.5.0.
- **Permissions removed**: `MANAGE_UPDATES` (feature deleted) and `MANAGE_STORAGE` (upload limits live under General behind `MANAGE_SETTINGS`); stale grants are inert.
- **Permissions added**: `MANAGE_EVENTS`, `MANAGE_ANNOUNCEMENTS`, `USE_SOUNDBOARD` and `MANAGE_SOUNDS`. Communities created from now on grant `USE_SOUNDBOARD` to their default role; in a community that already exists nobody holds the new permissions until a role is given them under Server Settings → Roles.
- The container drops privileges, so ports below 1024 can no longer be bound inside it; map them from the host instead.
- New optional environment: `PUBLIC_URL`, `TRUST_PROXY_HEADER`, `WS_MAX_CONNECTIONS_PER_IP`, `WS_MAX_CONNECTIONS_PER_USER`, `WS_CONNECTION_PARAMS_TIMEOUT_MS`, `MEDIASOUP_MODE`, `MEDIASOUP_PORT`, `MEDIASOUP_RTC_MIN_PORT` / `MEDIASOUP_RTC_MAX_PORT`, `MEDIASOUP_MAX_PARTICIPANTS`, `WEBRTC_TURN_URLS` / `WEBRTC_TURN_USERNAME` / `WEBRTC_TURN_CREDENTIAL`, `WEBRTC_ICE_TRANSPORT_POLICY`, `TOMBSTONE_RETENTION_DAYS`. All documented in the README, together with the new `config.ini` keys (`server.retentionDays`, `server.tombstoneRetentionDays`, `mediasoup.worker.mode`, `mediasoup.worker.port`, `mediasoup.maxParticipants`, the `webrtc` section, `federation.exposeDirectory`).
- The Updates panel is gone; upgrade with the compose commands above.
- New tables (events, signups, roster templates, plugin message links, import jobs, external identities, bridge links and bridge server links, polls, scheduled posts, channel follows, server sounds, directory cache) arrive in migrations 0037 through 0041; message tombstone columns in 0042. New crons run in-process: `events`, `scheduled-posts` and `polls-close` every minute, `bridge-sync` every minute, `federation-outbox` every 30 seconds, `federation-seen-jti` every 15 minutes, `game-presence-expiry` every 5 minutes, `directory-counts` hourly, and `directory-pull`, `log-retention`, `tombstone-retention` and `cleanup-auth-sessions` daily at 04:00 server time plus once at boot. The import runs on an in-process queue.
- **Deleted messages stay as placeholders** for `server.tombstoneRetentionDays` (default 30; `0` keeps them; env `TOMBSTONE_RETENTION_DAYS`). Messages deleted before the upgrade are already gone.
- Each plugin gets its own member account the first time it acts in a community; existing bridged messages stay under the owner's account.
- Avatar placeholder colours change once for everyone (they now key on the stable public id).
- The **bridge** and **watch-together** plugins ship in the image and are copied into the data directory's `plugins/` folder on every boot, off by default; enable them under Instance → Plugins and allow plugin commands in the community. Watch-together's address check makes one ranged request through the hardened fetcher (and one keyless oEmbed request for a YouTube link).
- **Game presence** needs the desktop app to report a game; the browser build only shows what others share. The setting is off until a user turns it on.
- **The tab layout is the default** on screens 768 px and wider for anyone who never chose a layout; Appearance → Layout → Traditional layout restores the rail.
- The bridge plugin's bot token is a secret setting: it is encrypted on first load after the upgrade and never shown again (set a new one to replace it). On the remote side the bot needs Manage Webhooks, Manage Messages, Manage Threads, Create Public Threads, Send Messages in Threads, Add Reactions, Manage Events, View Channels and Read Message History, plus the Server Members and Message Content intents.
- Importing from another chat service needs a bot with the two privileged intents (Server Members, Message Content) enabled in that service's developer portal; the wizard says so. Without Message Content every imported message arrives empty.
