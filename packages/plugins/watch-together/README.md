# watch-together

An official PULSE plugin that lets people watch something together: one member runs `/watch play <link>` — a YouTube link or a direct media address — and everyone's client plays the same thing in step, with play, pause and seek shared. Typed into a **text channel**, the command posts a **watch card** in that channel that anyone reading it can watch from; run from a **voice room**, it puts a stream card in the room. It ships inside the PULSE image under the data directory's `plugins/` folder and is **off by default**. It is written against the plugin SDK (`messages.post`/`edit` with card metadata, `createStream` with a `media` descriptor, commands, settings and HTTP routes) — no server internals.

## What it plays — read this first

**A YouTube link, or a direct media address.**

A **YouTube link** in any of its usual forms — `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/shorts/…`, `youtube.com/embed/…`, `youtube-nocookie.com/embed/…`, `youtube.com/live/…` — plays through YouTube's **own embedded player**: every member's browser loads the site's IFrame player (from the privacy-enhanced `youtube-nocookie.com` host) and the client drives it through the official IFrame Player API, so shared play, pause and seek work exactly as for a file and nothing is downloaded, resolved or relayed. What the site's player does not do, this cannot either: a private or removed video, or one whose owner disallows embedding, does not play (the address check refuses it up front); the video's own ads and branding are the site's; and its audio plays through the browser's default output rather than the call's chosen output device. Only the first video of a playlist link plays.

A **direct media address** must be something a browser can play as it is:

- a video or audio **file**: `.mp4`, `.m4v`, `.webm`, `.ogv`, `.ogg`, `.mov`, `.mp3`, `.m4a`, `.aac`, `.oga`, `.opus`, `.wav`, `.flac` (served with a `video/*` or `audio/*` type), or
- an **HLS playlist**: `.m3u8` (`application/vnd.apple.mpegurl` or `application/x-mpegURL`).

**Pages of other video sites are not resolved.** A Vimeo, Twitch, Dailymotion (…) link is a page with a player, not a media file; turning it into a playable stream needs that site's private player API, which no first-party code here speaks and which their terms forbid. The command refuses such links and says so. If you have the right to play a file, host it somewhere reachable (your own web server, object storage, a CDN) and paste that address.

The server never fetches, transcodes or relays the media: it publishes the address (for a YouTube video: the canonical watch address and the video id) and the transport state, and every member's browser plays it directly. For a media address that means:

- the **members' browsers** must be able to reach the address (a file on your LAN is only watchable by people on that LAN; the plugin refuses private addresses outright);
- the host must send **CORS** headers if the file is on another origin and the browser needs them for HLS (`Access-Control-Allow-Origin`); plain `<video>` playback of a file does not need CORS;
- HLS plays natively on Safari and iOS and through `hls.js` (loaded on demand by the client) elsewhere;
- a browser may hold playback until the person interacts with the page once; the card then shows a play prompt.

## Setting it up

1. **Enable the plugin** as the instance owner: Server Settings → Instance → Plugins → `watch-together` → switch it on.
2. **Allow plugin commands** on the community: Server Settings → General → plugins enabled, and give the members who should start sessions the **Execute plugin commands** permission (the room's moderators — Manage Users — can always control a running session).
3. Optional setting **Check addresses before playing** (on by default): the server fetches the first byte of a media address through its hardened client (private and link-local targets refused, DNS pinned, no redirects) and refuses dead links and web pages up front. For a YouTube link it asks the site's public oEmbed endpoint instead (one keyless request): a private, removed or non-embeddable video is refused, and the answer's title names the stream card; if the server cannot reach the site at all the video still plays, under a generic title. Switch the setting off when the server cannot reach the media host but the members can; the extension then decides what is media and YouTube cards carry the generic title.

## Using it

### From a text channel — the watch card

Type `/watch play <link>` into a text channel's composer (a thread works too) — typing `/watch ` lists the verbs below, and the composer's hint shows what each takes. The plugin posts a **watch card** there: the title (a YouTube video's own, or the file name), its poster, who started it, whether it plays or is paused, how far it is, and how many have it open. The command's own reply says `Playing in #channel — press Watch on the card.`

**Watch** on the card opens the synced player — a side panel in the tab layout, a dialog in the traditional one — with the same shared position everyone else has; a viewer who falls behind (a browser that will not start a video without a click) gets **Catch up**. Volume is each viewer's own and deafening mutes it. The starter and the community's moderators (Manage Users) get play, pause, seek and stop on the player; the same words typed into that channel's composer do the same:

| Command (in the card's channel) | Effect |
| --- | --- |
| `/watch play <link>` | Play a link for everyone: post a card for it. A live card in the channel is ended first — only by its starter or a moderator. |
| `/watch play` | Resume when paused. |
| `/watch pause` | Pause for everyone reading the card. |
| `/watch seek <seconds>` | Jump everyone to a position (seconds from the start). |
| `/watch stop` | End the watch: the card reads **Ended** and its Watch button disables. |
| `/watch status` | What is playing, where it is, who started it, how many watch. |

These are the command's declared sub-commands (`play [link]`, `pause`, `seek <seconds>`, `stop`, `status`); the bare `/watch <address>` still starts a watch, for anyone used to typing it that way. The viewer presence reports below are two hidden sub-commands (`watching <channel>`, `left <channel>`): callable by the client, never listed.

**The card is the session.** Its whole state lives in the message's plugin metadata (`metadata.watch = { kind, url, videoId?, title, startedBy, playing, position, updatedAt, viewers, endedAt? }`), and every control is one edit of that message, so the ordinary message update reaches everyone who can read the channel and a late reader simply reads the card — no extra events. Edits are throttled to one a second per card (a dragged slider sends many seeks; the last one is what goes out), except the final "ended" edit, which goes out at once.

**One live card per channel.** A card ends on `/watch stop`, when a new `/watch play <link>` replaces it, when the plugin is switched off — and **when nobody has had the player open for ten minutes**. Presence works like this: while a member has the player open their client runs `/watch watching` for the card's channel once a minute (and `/watch left` on close); the plugin keeps the set of viewers in memory, forgets a viewer whose last report is older than two and a half minutes, and ends a card whose viewer set has been empty for ten minutes (a fresh card gets those ten minutes to be opened). The count on the card is that set's size. Presence goes through the command, so a member without the **Execute plugin commands** permission watches all the same but is not counted — a card only such members have open ends after the ten minutes. A card deleted by a moderator ends its session quietly.

Which path a command takes: the composer's channel wins — `/watch …` typed into a text channel always addresses the card there, even by a member sitting in a voice room; the card's buttons name the channel explicitly (and may only control a card of the member's own community); with neither, the command addresses the voice room the member is in. Starting a card is only possible from the channel's composer (the server has checked that the member may post there); naming a channel from elsewhere can control or report, never start.

Over `plugins.executeCommand` both spellings work: the declared one (`{ commandName: "watch", subcommand: "seek", args: { seconds: 90, channelId } }`) and the positional one the card's buttons send (`{ commandName: "watch", args: { action: "seek", position: 90, channelId } }`).

### From a voice room

Join a voice channel, then use the **Watch together** button in the voice controls (the same `/watch` words through `plugins.executeCommand` without a channel):

| Command | Effect |
| --- | --- |
| `/watch play <link>` | Start playing the link — a YouTube link or a media address — in your voice channel. Replaces a running session only if you are its host or a moderator. |
| `/watch play` | Resume when paused. |
| `/watch pause` | Pause for everyone. |
| `/watch seek <seconds>` | Jump everyone to a position. |
| `/watch stop` | Take the stream down. |
| `/watch status` | What is playing, where it is, who started it. |

The stream card in the voice grid shows the video with the shared position; the host and the moderators get play/pause/seek/stop buttons on it, everyone else gets volume (their own) and can pin the card. The session ends on `/watch stop` and when the room empties.

## HTTP routes

For automation (an OBS panel, a bot). Send the plugin's secret in `x-pulse-plugin-secret` (shown to the instance owner in the plugin's settings).

- `GET /plugins/watch-together/sessions` → `{ sessions: [{ channelId, serverId, title, url, kind, videoId?, playing, position, hostUserId, startedAt }], cards: [{ channelId, serverId, messageId, title, url, kind, videoId?, playing, position, startedBy, viewers, startedAt }] }` — voice rooms under `sessions`, text channels under `cards` (`kind` is `file`, `hls` or `youtube`; `videoId` only for `youtube`)
- `POST /plugins/watch-together/control` with `{ "channelId": 42, "action": "play" | "pause" | "seek" | "stop", "position"?: 90 }` → `{ session }` for a voice room, `{ card }` for a text channel (`null` after stop); `400` for a malformed body, `409` when nothing plays there. A channel is one or the other, so the id says which.

The secret holder acts as a moderator.

## How the clients stay in step

The stream carries `{ url, kind, videoId?, playing, position, updatedAt, hostUserId }`; the card carries the same fields as `{ kind, url, videoId?, title, startedBy, playing, position, updatedAt, viewers, endedAt? }`. Every control re-publishes the whole descriptor once (`VOICE_UPDATE_EXTERNAL_STREAM` for a room, the message update for a card); a client derives the live position as `position + (now − updatedAt) / 1000` while playing and nudges its player when it drifts by more than a second — a `<video>` element through `currentTime`, the YouTube player through `seekTo`. A member who joins late receives the descriptor with the room state (or reads the card) and lands at the right position. Clock skew between a member's machine and the server shows up as a constant offset of that size; nothing accumulates.

## Development

```
cd packages/plugins/watch-together
bun run check-types && bun run lint && bun test src
bun run build   # dist/index.js, what the image ships
```

The tests run the plugin against a fake SDK context (`src/__tests__/harness.ts`) with a hand-driven clock for the card sessions (`cards.test.ts`); the server's `plugins/__tests__/watch-together-plugin.test.ts` loads the built package through the real loader, from a voice room and from a text channel.
