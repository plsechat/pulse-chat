# Pulse Chat v0.4.0

Released: TBD

## Client layout

- New tab layout: open communities are tabs across the top, with back and forward history over them, drag to reorder, and a plus menu listing every community of yours. Friends, Messages, Inbox and Profile open as resizable panels on the right. The community rail is not shown in this layout.
- Home tab: recent conversations with last message and unread count, online friends, every community with unread and mention counts, the inbox, the coming week's events across communities, and current game presence. Each row opens the matching panel or community.
- The tab layout is the default on screens 768 px and wider. Appearance → Layout → Traditional layout restores the rail. Phones use the mobile layout regardless.
- Theme tokens reworked: canvas, channel pane and content pane as three layers; squircle avatars; contained composer with a formatting bar; relative timestamps; a distinct wash on messages that mention you. Every theme, including Onyx and the light themes, carries the new tokens. Tabs, headers and the active channel are tinted with the theme's primary colour.
- The avatar in the top-right tray opens account settings from any tab. Voice and status controls remain on the bottom-left card.
- Buttons that run out of room elide their label instead of overflowing, form controls shrink with their row, and icon buttons use one size scale (36, 32 and 24 px) instead of per-use overrides. The composer's attach, emoji, GIF and send buttons share one row centred on the text, and sit on the bottom line of the expanded composer. The voice card's Disconnect is an icon button so all five call controls fit the sidebar; the share button shows a plain monitor until you share. The forum tag editor keeps name, Save and Cancel on one line with the colour swatches beneath.
- Appearance zoom below 100 % no longer leaves an empty band under the app, and above 100 % dialogs and the composer stay on screen.

## Planner

- An Apps section in each community's channel list opens the Planner: month grid, agenda, event sheets with role rosters (templates, caps, a bench that auto-promotes, change role, withdraw, decline), host controls to bench and promote, RSVP cards in the announce channel, and roster templates under Server Settings → Events. Templates can be saved from the event editor ("Save as template") and reached from it ("Manage templates").
- New permission `MANAGE_EVENTS` gates creating and managing events. The owner of any community sees "New event" and the Events settings tab; owner roles created before this permission existed are backfilled by migration 0043.
- Each community has a Planner switch in Server Settings → General. Off hides the planner and pauses signups, reminders, the calendar feed, plugin event actions and event import; existing events are kept and return when it is switched on.
- The month grid does not offer past days for new events, the time picker starts at now for today, and editing re-checks the start only when it is moved. The Start time field fits at tablet widths.
- Reminders at 24 hours, 1 hour and start, as toast and desktop notification.
- Fifteen minutes before start a private voice room is created for the signed-up members and host. Fifteen minutes after the scheduled end it is removed and a summary is posted.
- Subscribe copies a calendar-feed URL. The link is invalidated when the member leaves the community. The feed refreshes after each change and advertises a 15-minute poll interval.

## Community import

- Server Settings → Integrations → Import (server owner): connect a bot, pick the source community, preview with warnings and a time estimate, choose history depth, attachments, members and roles, then run with pause, resume, cancel and retry. Categories, channels, roles, emoji, pins, threads, history, attachments and scheduled events are imported. Progress survives a server restart.
- Imported authors are placeholder accounts. When the person signs in through the matching provider with the same account, their history is moved to them. Imported people in the wizard lets an admin link a placeholder to a member by hand. Roles and membership carry over in both paths.
- Bot status cards (title, description, fields, footer) are imported as text; picker GIFs are imported as attachments. Skipped messages carry a reason (notice, empty, unreadable channel).
- A thread removed while the import runs is recreated instead of failing the job. The empty-thread sweep skips communities with an import in flight.
- Importing the same source community again reuses the categories, channels, roles and emoji the first run created instead of duplicating them.
- The message estimate samples the oldest and newest pages per channel; channels that fit one page are counted exactly.

## Chat bridge plugin

- The `discord-bridge` plugin ships in the image, off by default. Enable under Instance → Plugins and set its bot token.
- Server Settings → Integrations → Bridge links a whole community to a remote server: channels pair by name, or are created where missing on either side with their categories; new channels on either side are paired automatically; deletions are not mirrored. Each channel's Bridge tab can exclude the channel, override direction, or link a channel by hand.
- Mirrored in both directions: messages, edits, deletions, reactions, threads and scheduled events. Each side shows the other's authors by name and avatar. Encrypted channels and voice are not bridged.
- Status-bot cards and their edits arrive as text; picker GIFs arrive as attachments. A channel created or removed on the remote side, or a bot reconnect, triggers a sync at once. The last sync's outcome is persisted and shown after a restart.
- Plugins post under a member account of their own (labelled "Plugin" in the member list) instead of the instance owner's account, so the owner receives sounds, notifications and unread markers for bridged messages.

## Plugin SDK 0.4

- New actions: post, edit, delete and react to messages (with an idempotent `externalId`), create channels and threads, list members, upload files, outbound `fetch` through the hardened client, signed HTTP endpoints, create and update scheduled events. New events for reactions, threads, role changes and scheduled events.
- Plugins declared against `^0.1`, `^0.2` or `^0.3` load on a 0.4 server. Each 0.x minor is a superset of the previous one.
- Setting type `secret`: stored encrypted, never returned to the client. The bridge bot token uses it.
- `server.notify(topic, payload)` for in-process signals to the server; `onPluginLoaded` and `onPluginUnloaded` hooks on the server side; a changed entry file is reloaded on toggle without a restart.
- Messages carry structured card state through `metadata` on post and edit. External voice streams carry a shared-playback `media` descriptor. Command invokers carry `activeServerId`, `channelId` and `canModerate`.
- Commands declare `subcommands`, `choices`, `placeholder` and `hidden`. Positional spellings a plugin accepted before keep working.
- Full detail in packages/plugin-sdk/CHANGELOG.md.

## Slash commands

- Typing `/` in a channel opens a command palette: each command with its plugin's logo, description and arguments. Typing a command followed by a space lists its sub-commands; a hint above the composer shows the usage with the current argument marked. Choices are listed while the argument is typed.
- A member's command renders as a "used /name sub" line in their row with the reply beneath it. A refused command shows the reason on the line and as a toast to the invoker.
- The slash suggestion matched command descriptions, so `/watch pause` followed by Enter could pick a different command. It now matches names only.
- The command card rendered empty since v0.3.0 because the sanitiser dropped its `data-*` attributes. Fixed.

## Announcement channels, polls, scheduled posts

- A text channel can be switched to an announcement channel. Posting requires the new `MANAGE_ANNOUNCEMENTS` permission; everyone reads. Automated posts (plugins, webhooks) are not gated.
- Polls from the composer's plus menu: 2 to 10 options, single or multiple choice, optional anonymity, a closing time between 1 minute and 30 days, live results.
- Scheduled posts, with a Scheduled panel in the channel header to review and cancel them.
- Channel Settings → Follows: follow an announcement channel from another community on this instance or on a federated peer. Posts, edits and deletions arrive as announcement cards in the following channel.

## Public directory

- Server Settings → General: list the community with a description, tags and a game. Tags are edited as chips (Enter or comma adds, Backspace removes, paste splits), up to 5 of 24 characters from letters, digits, spaces, `_` and `-`, and shown as `#tag` on cards. Discover → Directory lists and searches communities from this instance and its federated peers; join from the card. Instance → Registration can keep the directory private to peers.
- The directory online-count query flattened its array parameter to a scalar, which broke the listing whenever anyone was online. Fixed.

## Soundboard

- Server Settings → Sounds: members with the new `MANAGE_SOUNDS` permission upload clips up to 5 seconds and 512 KB, 50 per community, each with an emoji and a level. Members with `USE_SOUNDBOARD` play them from the call controls, favourites first.
- The player's tile shows the clip's name. Deafened members do not hear clips; a moderator-muted member cannot trigger one. Rate limits: one clip per person every 2 seconds, ten per room per minute.

## Watch-together plugin

- The `watch-together` plugin ships in the image, off by default.
- `/watch play <link>` in a text channel posts a watch card: a YouTube link (watch, youtu.be, Shorts, embed or live), a video file, or an HLS playlist, with title, starter, state and position. Watch opens the synced player (side panel in the tab layout, dialog in the traditional one) at the shared position, with local volume, deafen muting it, and Catch up when the browser blocked autoplay. The starter and moderators share play, pause, seek and stop from the player or through `/watch pause`, `/watch seek`, `/watch stop`.
- One live card per channel. It ends on `/watch stop`, when a new link replaces it, or after ten minutes with nobody watching. The card stays in the channel.
- In a voice room, the Watch together button in the call controls plays for the room through a stream card.
- When the media ends the watch ends at its length for everyone (late readers see "Ended"); a voice-room watch pauses at the end and Play restarts it. Live streams are unaffected.
- YouTube plays through the site's embedded player via the IFrame API. Private and non-embeddable videos are refused up front. Pages of other video sites are not resolved and the command says so.
- The address check makes one ranged request through the hardened fetcher, plus one keyless oEmbed request for a YouTube link.

## Game presence

- With the desktop app, a user can share the game they are running (off by default, per-community opt-out under User Settings → Privacy). Shown as "Playing …" in the member list, "for N min" on profile cards, and a "Now playing" section at the top of the members pane. Works across federated communities. Presence clears on sign-out and after six hours at most.
- The desktop contract is documented in docs/desktop-integration.md. The desktop app has to implement `window.pulseDesktop.onGamePresence`; the browser build only displays what others share.

## Message deletion

- A deleted message stays in place as a *Message deleted* placeholder. Text, attachments, reactions, link previews and pin are removed at once. Replies, thread roots and deep links keep resolving. Holders of Manage messages see who deleted it and when.
- Applies to channel messages, DMs including encrypted ones, bulk moderation, report takedowns, plugin deletions and copies in following channels. Clearing a whole channel still removes everything.
- Placeholders are removed after `server.tombstoneRetentionDays` (default 30, `0` keeps them, env `TOMBSTONE_RETENTION_DAYS`). Deleted messages do not count as unread, do not appear in search or pinned lists, and cannot be edited, reacted to, pinned, forwarded, replied to or turned into a thread.

## Mobile layout

- Opaque channel and member drawers with swipe gestures that yield to code blocks, scrollers and menus. The platform Back gesture closes drawers, sheets, threads and the settings card.
- A header overflow menu holds channel topic, encryption status, Search, Pinned, Threads and notification settings as full-height sheets. Threads and forum posts open full-screen with a Back arrow.
- A compact in-call bar under the header while in voice, and a floating tile for a pinned camera or screen share.
- The soft keyboard no longer pans the layout. Enter inserts a newline on touch keyboards; the Send button sends. Message actions appear for the tapped message only, below its text; long-press still opens the message menu. Popovers, embeds, settings panes and admin tables fit the viewport.
- Reloading while a federated server is in focus returns to that server.

## Authentication

- Local auth backend: refresh tokens form revocable families. Logging out revokes the session server-side, changing the password revokes every other session, and a replayed old token revokes the whole family. Access tokens live 15 minutes and are renewed before every connect and upload.
- Local-backend emails are case-insensitive. Unknown emails take the same time to reject as wrong passwords. Password minimum is 8 characters. OAuth providers are advertised only under the Supabase backend.

## File access

- Attachment links in private channels and DMs are signed with a 12 to 24 hour expiry. The channel re-keys when a member loses access (kick, ban, leave, role or override change, privacy flip, account deletion), so earlier links stop resolving.
- Uploaded audio and video support HTTP Range requests. Public media is cacheable.

## Roles

- Every role has a position. A member can create, edit, assign, delete or reorder only roles below their own top role, and can grant only permissions they hold. The roles list is ordered highest first with drag-to-reorder limited to movable roles.
- Leaving, being kicked or being banned removes the member's roles and overrides in that server. Permission changes apply to live connections immediately.

## Plugin loader

- The loader read a setting the UI never wrote, so plugins never loaded. Fixed.
- A Plugins panel under Server Settings → Instance for the instance owner. The per-community Plugins switch in General gates command execution in that community; on the instance owner's own community it also controls loading at boot.
- The loader enforces the SDK compatibility range. New events `member:joined` and `member:left`.
- Official plugins are copied from the image into the data directory's `plugins/` folder on every boot.
- The Plugins panel's Commands dialog lists every plugin's commands and sub-commands regardless of which community is active, and says when the current community has plugin commands switched off.

## Settings and administration

- Upload limits (allow uploads, max file size, per-member quota, overflow action) moved into General under `MANAGE_SETTINGS`. The enforced limits are the configured values rather than seeded defaults.
- Server Settings opens for anyone who may see at least one section and lands on the first allowed one. Every instance panel has a loading state, an inline error and Retry. Health pauses polling while the tab is hidden.
- Zoom and font scale are available to all users. New Onyx theme (true black). System theme follows the OS appearance live.
- A refused General save shows a toast, marks the field and scrolls to it; only changed fields are sent, the description is capped at 128 characters in the form, clearing the join password works, and the password is redacted from the activity log. Settings forms, dialogs and profile saves report failures with a toast instead of failing silently.
- The "message sent" sound is off by default with its own switch under Sounds & notifications. The Calls switch and chosen sound variants are saved to the server instead of resetting on reload.
- Group DMs can be renamed and given an icon.
- Auto-Mod timeout action works: timed-out members cannot send or join voice, with a chip in the member list. Alerts render as system notices with a "Review rules" link.
- `server.retentionDays` (default 90) prunes login and activity history. Account deletion removes everything it should. Logs redact tokens and secrets before any transport or the admin tail.

## Federation

- Allowlisted IP-literal and localhost peers work again. Every outbound federation fetch is DNS-pinned and size-capped. Link previews use the same pinned fetcher.
- Relays go through a durable outbox: persisted, retried per peer with backoff, dead-lettered after eight attempts or 48 hours. The instance panel shows pending and undelivered counts, peer version and a retry action. The server rail marks a degraded peer.
- Presence is relayed to peers. Key rotation with a 24-hour grace period. Unpeering notifies the other side and removes ghost DMs. Reports against a federated user are relayed to their home instance.
- Federated communities show their own logo on the community tab, the channel-list header, the Home overview and the Inbox, and pick it up from the community itself on first connect in a fresh browser.
- The Content-Security-Policy allows images, media and connections from peers this instance reaches over plain HTTP (localhost and allowlisted private peers), so their logos, avatars and attachments load on plain-HTTP deployments. Nothing changes for HTTPS peers or when there are none; an HTTPS instance is still subject to the browser's mixed-content rules.
- An expired federation token is re-minted and the connection re-established. Shadow identities are keyed by home instance plus public id. Concurrent first contact yields one DM channel.

## End-to-end encryption

- The own-message plaintext cache is keyed by instance, kind and id and bound to its ciphertext. A channel, group-DM and federated message with the same numeric id no longer collide, and an edited sender-key message re-decrypts.
- Late joiners receive sender keys. Pending keys are pulled on every federated connect. A bad pairwise ciphertext no longer wipes the session. Friends-only encrypted DMs can establish a session.
- An identity reset silently re-pins trust-on-first-use peers and prompts for a manually verified identity. Nothing is re-keyed until the user accepts.
- Threads and forum posts under an encrypted channel inherit encryption. docs/e2ee-sender-keys.md states the single-device contract and what the server can still see.

## Voice

- DM calls and server channels sharing a numeric id no longer leak media or roster into each other. Deleting a channel, DM or server, or leaving, evicts everyone from the live call.
- Media runs on one port (40000 udp and tcp) by default with an instance-wide participant cap. Capacity exhaustion answers "Voice capacity reached". TURN relay configuration is documented.
- The server owner cannot be muted, deafened, disconnected, kicked or banned. Server-deafen is enforced at the SFU. Moderation overrides survive rejoin.
- Reconnecting rejoins the voice session. Microphone and transport failures are surfaced. A failed join no longer leaves a ghost participant.
- Output device selection works. Plugin audio plays once. The incoming-call ring has its own toggle. The quality ladder is clamped to the instance cap.
- Screen share bitrate follows the chosen resolution and frame rate (about 3.5 Mbps for 1080p15, up to the 20 Mbps producer cap for 2160p60) instead of a flat 2.5 Mbps. Shares at 30 or 60 fps use the motion content hint and maintain-framerate degradation. "Share system audio" toggle under User Settings → Devices.

## Security

- Uploads are served under a sandboxing CSP; only images, video, audio and PDF inline, everything else as an attachment. Intake pre-checks quotas, bounds names and sweeps leftovers at boot.
- Rate limits key on ip and path with a capped store and cover public files, webhooks and federation. Trusted-proxy resolution is one helper with explicit opt-in for proxy headers. WebSocket connections are capped per IP and per user. CSP drops `unsafe-eval`; the only external script hosts are the YouTube player API hosts. HSTS on https. CORS no longer breaks encrypted uploads to federated instances.
- Authorization: no active server means no permissions. Search excludes private-channel messages the user cannot see. Replies must reference the same channel. Private channel rows and threads fan out only to viewers. Overrides are evaluated on every channel. Invite codes are consumed atomically and released on failure. A partial settings update no longer clears the server password. Every router bounds its inputs. Cross-server ids read as nonexistent rather than as a permission failure.
- Webhooks validate their body, refuse encrypted and voice channels, run automod and never fetch an avatar URL.
- DMs: the pin banner, search results and pinned list render through the same sanitised body as messages. Searching an encrypted DM matches locally decrypted text; the server only searches plaintext rows.
- Client: one live home socket. Home actions (mark read, mute, notes, status) always go to the home instance. Remote-instance events no longer land in the home badge map. Being removed from a group DM drops it at once.

## Forums

- A forum post opens as a post: title, author and the opening message with its image gallery, replies below. The post list shows each post's first image, private forums included.
- Archived posts are listed with the "Archived" filter, carry an "Archived" label and are archived or unarchived from the post menu by members with `MANAGE_CHANNELS`; authors may unarchive their own posts. Replies to archived threads are refused.
- The 10-image limit is shown in the create dialog with a counter and hint; the attachment caps are shared constants.
- Post previews, and the forum search that filters on them, show plain text instead of raw markdown.

## Fixes

- Channels no longer stay greyed out after switching back to them.
- Message lists keep following new messages while you are at the bottom, including tall messages, late-loading previews and images, and at the 300-message window; your own sent message always scrolls into view. "Jump to Present" appears only when you have scrolled up.
- Reactions are stored by shortcode on every path (members, DMs, plugins, the bridge), so unicode reactions render as emoji instead of broken custom-emoji images and the same emoji in any spelling counts as one reaction.
- A dialog opened during another dialog's 150 ms close fade was discarded with it. Fixed with a generation counter.
- Right-clicking a link in a message shows the browser's own link menu. The desktop app and touch long-press get a "Copy Link" item in the message menu.
- Share links from other services whose path resembled a video id no longer render as a broken player.
- Avatar placeholder colour is the same in every surface and on every federated instance; it keys on the public id.
- Renaming a community or changing its description updates every member's sidebar header, tabs, rail, Discover and Directory cards live.
- Edited messages, blockquotes, code fences and paragraphs after code blocks survive the editor round-trip.
- Search with a "has file" filter no longer fails. DM read state syncs across sessions. Paging back no longer regresses the read marker.
- Jump-to-message re-centres in the narrow deck pane.
- The deck Messages panel has Create Group DM.
- Inter is self-hosted and loads under the CSP. The Home button has an accessible name. 57 icon-only buttons gained labels and a lint rule enforces it. The colour swatch, sheet close and fullscreen image are keyboard-reachable.
- Hopping between voice channels plays only the join cue. Own-voice flags reset on leave.
- The tab title and desktop badge count unread across every server and DM. Desktop-notification settings show the browser permission state.
- A failed queue job no longer discards the remaining queued jobs. The server shuts down on SIGTERM. Webhook avatars and group-DM icons are no longer deleted as orphans.
- YouTube playback: volume 0 is treated as mute, since the IFrame player's `unMute()` restores the previous volume.
- `plugins.onCommandsChange` stayed silent when plugins were off at connect time. Fixed.

## Internals

- Initial JavaScript drops from one 5.5 MB chunk to about 2.2 MB across cacheable vendor chunks. Pickers, settings, tweets, mediasoup, libsignal and supabase-js load on first use. Message lists keep a 300-message window per channel.
- `@pulse/shared` is a standalone package. Row-derived types are published by the server and imported type-only by the client.
- Routes run on scoped procedure builders.
- Migrations 0029 through 0043 apply on boot: removal of the updates permission, local-auth email normalisation, role positions, settings source of truth, integrity foreign keys and indexes, automod timeouts, local auth sessions, relay outbox, shadow identity and DM pair keys, events and plugin message links, import jobs and external identities, channel and whole-server bridge links, polls, scheduled posts, follows, sounds, directory cache and game presence, message tombstones, the Planner switch and the owner-role permission backfill.
- Locked crons take their advisory locks on a separate pool. Twelve crons starting at boot exhausted the main pool.
- Tests: the server suite passes in one process; about 700 client unit tests across about 100 files; every probe spec is a real test; a core-mobile Playwright project runs on a Pixel 7 profile; a nightly upgrade smoke boots the previous published image and upgrades it on the same volumes.
- The Docker image runs unprivileged, with a health check that follows the configured port and a stop signal. Releases ship SHA256SUMS, provenance and SBOM attestations and require green CI on the commit.
- The Updates feature, which never worked, was removed end to end.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Schema changes apply on boot. One-time effects:

- Local auth backend: every user signs in once. Tokens minted before this release carry no session family and are rejected.
- Safety numbers change once for everyone. They now hash stable public ids, so a federated pair sees identical digits. Pins and verification status are untouched.
- Private attachment links expire after 12 to 24 hours. Links copied out of the app stop working after that.
- Voice networking defaults to a single port 40000 (udp and tcp). An existing `40000-40020` mapping keeps working. `MEDIASOUP_MODE=range` restores the range behaviour.
- Federation wire changes: `/federation/servers` is a signed POST, `/federation/user-info` is public-id only with a signed response, `/federation/accept` verifies the full body (the domain-only signature is still accepted this release). New endpoints: `/unpeer`, `/key-rotation`, `/report-user`, `/directory`, `/announcement-follow`, `/announcement`. Peers on the previous release still bootstrap against this one; see docs/federation.md "Version compatibility".
- API renames with a one-release alias: `others.joinServer` → `others.openSession`, `servers.join` → `servers.joinByInvite`, `users.onJoin` → `users.onConnected` (event `USER_CONNECTED`). Becoming a member emits `SERVER_MEMBER_JOIN` to every member. Plugin events: `user:joined` → `user:connected`, `user:left` → `member:left`, new `member:joined`. The old names work in v0.4.0 and are removed in v0.5.0.
- Permissions removed: `MANAGE_UPDATES` and `MANAGE_STORAGE`. Stale grants are inert.
- Permissions added: `MANAGE_EVENTS`, `MANAGE_ANNOUNCEMENTS`, `USE_SOUNDBOARD`, `MANAGE_SOUNDS`. New communities grant `USE_SOUNDBOARD` to their default role. Migration 0043 grants each community's owner role every permission it is missing; other roles hold none of the new permissions until granted them under Server Settings → Roles.
- The container drops privileges. Ports below 1024 cannot be bound inside it; map them from the host.
- New optional environment: `PUBLIC_URL`, `TRUST_PROXY_HEADER`, `WS_MAX_CONNECTIONS_PER_IP`, `WS_MAX_CONNECTIONS_PER_USER`, `WS_CONNECTION_PARAMS_TIMEOUT_MS`, `MEDIASOUP_MODE`, `MEDIASOUP_PORT`, `MEDIASOUP_RTC_MIN_PORT` / `MEDIASOUP_RTC_MAX_PORT`, `MEDIASOUP_MAX_PARTICIPANTS`, `WEBRTC_TURN_URLS` / `WEBRTC_TURN_USERNAME` / `WEBRTC_TURN_CREDENTIAL`, `WEBRTC_ICE_TRANSPORT_POLICY`, `TOMBSTONE_RETENTION_DAYS`. New `config.ini` keys: `server.retentionDays`, `server.tombstoneRetentionDays`, `mediasoup.worker.mode`, `mediasoup.worker.port`, `mediasoup.maxParticipants`, the `webrtc` section, `federation.exposeDirectory`. All documented in the README.
- The Updates panel is gone. Upgrade with the compose commands above.
- New tables in migrations 0037 through 0041: events, signups, roster templates, plugin message links, import jobs, external identities, bridge links, bridge server links, polls, scheduled posts, channel follows, server sounds, directory cache. Message tombstone columns in 0042.
- New in-process crons: `events`, `scheduled-posts`, `polls-close` and `bridge-sync` every minute; `federation-outbox` every 30 seconds; `federation-seen-jti` every 15 minutes; `game-presence-expiry` every 5 minutes; `directory-counts` hourly; `directory-pull`, `log-retention`, `tombstone-retention` and `cleanup-auth-sessions` daily at 04:00 server time and once at boot. The import runs on an in-process queue.
- Deleted messages stay as placeholders for `server.tombstoneRetentionDays`. Messages deleted before the upgrade are already gone.
- The Planner is on for every community (`servers.enable_events`); a community admin turns it off under Server Settings → General.
- New reactions are stored as shortcodes (`+1`, not `👍`). Existing rows keep their spelling and render the same; a plugin or API client reading `message_reactions.emoji` sees shortcodes from now on.
- The "message sent" sound is off for everyone until switched on under Sounds & notifications.
- Each plugin gets its own member account the first time it acts in a community. Existing bridged messages stay under the owner's account.
- Avatar placeholder colours change once for everyone.
- The bridge and watch-together plugins are copied into the data directory's `plugins/` folder on every boot, off by default. Enable them under Instance → Plugins and allow plugin commands in the community.
- Game presence requires the desktop app to report a game. The setting is off until a user turns it on.
- The tab layout is the default on screens 768 px and wider for anyone who never chose a layout.
- The bridge plugin's bot token is a secret setting: an existing plaintext value is encrypted on the first load after the upgrade and never shown again. The remote bot needs Manage Webhooks, Manage Messages, Manage Threads, Create Public Threads, Send Messages in Threads, Add Reactions, Manage Events, View Channels and Read Message History, plus the Server Members and Message Content intents.
- Community import needs a bot with the Server Members and Message Content intents enabled. Without Message Content every imported message arrives empty.
