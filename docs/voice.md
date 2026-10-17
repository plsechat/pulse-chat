# Voice — runtime lifecycle and ownership

How voice sessions are created, owned, torn down, and moderated.
Server code: `apps/server/src/runtimes/voice.ts` (the runtime + registry),
`routers/voice/` (shared WebRTC plumbing + server-channel routes),
`routers/dms/voice-*.ts` (DM calls), `utils/voice-cleanup.ts`,
`crons/cleanup-orphan-voice.ts`. Client: `components/voice-provider/`
(ordering-sensitive — see notes at the bottom).

## The runtime registry

One `VoiceRuntime` per live call: a mediasoup router plus per-user
transports, producers (mic / webcam / screen / screen-audio), consumers,
roster state, moderation overrides, and ephemeral screen-share preview
thumbnails.

- **Keys are kind-qualified**: `channel:<id>` for server voice channels,
  `dm:<id>` for DM calls. `channels.id` and `dmChannels.id` are
  independent serial sequences, so one number can name both at once —
  every by-id lookup states its keyspace (`findById(id, kind)`,
  default `'channel'`). The shared WebRTC routes
  (transports/produce/consume/state) resolve via
  `VoiceRuntime.requireByCtx(ctx)`, which derives the keyspace from
  `ctx.currentDmVoiceChannelId` — set by `dms.voiceJoin`, cleared by
  both leave routes AND by a server-channel join (a stale DM marker
  would misroute the session).
- Server-channel runtimes are pre-created for every voice channel at
  boot (`runtimes/index.ts`); DM runtimes are created on first join.
  Registry state is in-memory only — a server restart drops all calls.
- `getVoiceMap` / `getExternalStreamsMap` are server-channel-scope maps
  keyed by numeric channel id; they skip DM runtimes by construction.
- **Events carry the kind.** `USER_JOIN_VOICE`, `USER_LEAVE_VOICE` and
  `USER_VOICE_STATE_UPDATE` payloads carry `kind: 'channel' | 'dm'`
  (`TVoiceKind` in `@pulse/shared`) next to the numeric `channelId`; the
  client keys its voice map by `${kind}:${id}`. The room-scoped media
  bus (`VOICE_NEW_PRODUCER` / `VOICE_PRODUCER_CLOSED`,
  `pubsub.publishForChannel` / `subscribeForChannel`) is keyed by the
  runtime key string, never the bare id — a DM call and a server channel
  with the same id are different rooms and must not see each other's
  producer events.

## Session lifecycle

**Join** (`voice.join` / `dms.voiceJoin`):
1. Self-heal: if the user is already in ANY runtime (stale session from
   a refresh), remove them first — a rejoin must clear the old session,
   not brick the user.
2. Capacity: `VoiceRuntime.assertCapacity()` refuses the join with
   `PRECONDITION_FAILED "Voice capacity reached"` once the instance-wide
   participant count (every channel and DM call) has reached
   `config.mediasoup.maxParticipants` (0 = unlimited). Checked after the
   self-heal so a rejoin never counts its own stale session.
3. Get-or-create the runtime (init builds the mediasoup router; on init
   failure the runtime is destroyed, not leaked).
4. `addUser` (merging any standing moderation override), stamp the
   connection: `ctx.currentVoiceChannelId` (+ `currentDmVoiceChannelId`
   for DM calls), and `ctx.setWsVoiceKey(runtime.key)` on the socket.

**Ownership stamp** (`ws.voiceKey`, see `declarations.d.ts`): voice
membership belongs to the *connection* that joined, not the account.
Stamping one socket clears the stamp on the user's other sockets, so a
zombie connection's delayed close can't tear down the session a fresh
connection just rejoined. The WS close handler tears down voice only
when the closing socket's stamp matches the runtime the user is
actually in (`runtime.key === ws.voiceKey`) — and it runs independent
of token validity, so an expired-mid-call token can't leak the entry.

**Leave** (`voice.leave` / `dms.voiceLeave`): falls back to
`findRuntimeByUserId` when the connection context has no channel (after
a refresh the new connection never joined but the stale session must be
removable). Clears both ctx markers and the socket stamp.

**Teardown**: `removeUserFromVoice` removes the user, publishes the
leave (and the DM call lifecycle events) and destroys the runtime when
it empties (frees the mediasoup router). `evictRuntime` runs it for
every occupant and then destroys the room — used when a voice channel,
a DM conversation or a whole server is deleted, so occupants are told
instead of being left "connected" to a room that no longer exists.
Leaving a server (`servers.leave`), leaving a group (`dms.leave`) and
being removed from a group (`dms.removeMember`) also evict the user from
that server's / that group's call. Belt-and-braces: `cleanup-orphan-voice`
cron sweeps users with no live WS connection out of all runtimes — a
mid-refresh user may be swept during the gap; the self-healing join
makes that harmless.

## Media

- Codecs: H264 (packetization-mode 1) is listed before VP8 —
  hardware-encoder friendly; forcing H264 for screen share resolved
  severe encoder heat on macOS clients.
- Audio: opus with FEC/DTX/stereo/bitrate from operator config
  (`config.ini` → `mediasoup.audio.{maxBitrate,stereo,fec,dtx}`,
  defaults 510 kbps / on / on / on).
- Produce caps (`routers/voice/produce.ts`, enforced server-side via
  `superRefine` so a client cannot claim more): audio and screen-audio
  510 kbps, webcam 3 Mbps, screen share 20 Mbps, at most 60 fps and 3
  encodings per producer; external (plugin) streams use the same
  audio/video ceilings. The client asks for less than the cap: a ladder
  per resolution and frame rate (`media-policy.ts`, 1080p15 ≈ 3.5 Mbps,
  1440p60 ≈ 14 Mbps, 2160p60 = 16 Mbps) with `contentHint` `detail` at
  15 fps and `motion` at 30/60, and a degradation preference that holds
  resolution at 15 fps and the frame rate above — a flat 2.5 Mbps cap
  used to turn high-resolution 60 fps shares into a slideshow.
- Screen-share hover previews are a pull model: the sharer pushes a
  bounded JPEG data-URL periodically (`updateStreamPreview`, only while
  actually sharing); roster hover queries it (`getStreamPreview`,
  VIEW_CHANNEL-gated via `channelProcedure`, previews excluded). The
  thumbnail is dropped when sharing stops. Never fanned out.

## Networking

- **One media port (default).** At startup the worker creates one
  `WebRtcServer` bound to `config.mediasoup.worker.port` (default
  `40000`, env `MEDIASOUP_PORT`) for UDP **and** TCP, and every
  `WebRtcTransport` — send and receive, every channel and DM call —
  multiplexes over that socket pair. One firewall rule, one Docker port
  mapping (`-p 40000:40000/udp -p 40000:40000/tcp`), and no participant
  ceiling from ports. The effective mode and capacity are logged at
  startup (`[voice] media mode: …`); a port that cannot be bound fails
  startup with an actionable message rather than a dead voice stack.
- **Range mode** (`mediasoup.worker.mode = 'range'`, env
  `MEDIASOUP_MODE=range`) is the pre-WebRtcServer behaviour kept for
  operators whose network depends on per-transport ports: each transport
  binds one UDP and one TCP port from `rtcMinPort`–`rtcMaxPort` (default
  `40000`–`40020`; UDP and TCP are separate pools), so the instance
  holds about *range size / 2* participants in total. Exhausting the
  range is mapped to the same `PRECONDITION_FAILED "Voice capacity
  reached"` the participant cap raises, instead of the opaque
  INTERNAL_SERVER_ERROR mediasoup produced. Plugin RTP ingest
  (`PlainTransport`) draws from this range in both modes.
- **Capacity.** `config.mediasoup.maxParticipants` (env
  `MEDIASOUP_MAX_PARTICIPANTS`, default `0` = unlimited) caps concurrent
  voice participants across the whole instance — mediasoup runs on one
  worker, so this is the operator's CPU/bandwidth guard. The admin
  health panel's `VoiceRuntime.getStats()` reports the live count.
- **Address.** mediasoup is ICE-lite — the server never gathers
  candidates and announces exactly one host candidate per protocol. In
  production the sockets listen on `0.0.0.0` and announce
  `SERVER_PUBLIC_IP` (`PUBLIC_IP` env, else auto-detected); in
  development they listen on `127.0.0.1` with no announced address.
  `getMediaListenInfo()` in `utils/mediasoup.ts` is the one place this
  pair is derived; plugins get it via
  `PluginContext.actions.voice.getListenInfo()` so their transports
  advertise consistently.
- **Why no STUN.** STUN exists so a peer behind NAT can learn its public
  address. The server already knows its address (it announces it) and
  the client never needs to be reachable — it connects *out* to the
  announced address (UDP preferred, TCP fallback). So the server needs
  no STUN and no TURN, ever.
- **When TURN matters.** Only a client that can reach the media port
  over neither UDP nor TCP (a corporate proxy that allows HTTPS only, a
  network that blocks the port outright) needs a relay. Operators can
  configure one with `WEBRTC_TURN_URLS` (comma list of `turn:` /
  `turns:` URLs, at most 8; `stun:` entries are accepted too),
  `WEBRTC_TURN_USERNAME`, `WEBRTC_TURN_CREDENTIAL` and
  `WEBRTC_ICE_TRANSPORT_POLICY` (`all` default, `relay` forces every
  client through the relay). `config.ini` has the same keys under
  `[webrtc.turn]` / `[webrtc]`; env wins. `/info` exposes them as
  `iceServers` + `iceTransportPolicy` (omitted when unconfigured) and the
  client passes them to both transports. The credential is handed to
  every client by design — use time-limited TURN credentials or a relay
  you control. Values are bounded and scheme-checked
  (`helpers/webrtc-ice.ts`).
- **ICE restart**: on a transport `disconnected` event the client calls
  `voice.restartIce` for that transport instead of rebuilding it.

## Moderation

`voice.moderateMember` (server-mute / server-deafen) and
`voice.disconnectUser`, gated on MANAGE_USERS via `serverProcedure`:

- Target resolved by user, DM calls explicitly excluded, and the
  target's channel must belong to the invoker's active server — the
  refusal message is identical to "not in voice" so moderators can't
  probe other servers' voice occupancy.
- **Owner protection**: the server owner is never a target.
  `assertModerationTarget` in `utils/server-moderation.ts` is shared by
  mute/deafen, disconnect, kick and ban (the kick/ban cores enforce it,
  so report resolution is covered too).
- **Enforced at the SFU, not advisory.** serverMuted pauses the target's
  audio producer (and a producer created later starts paused);
  serverDeafened pauses every audio consumer the target holds (mic,
  screen audio and plugin audio alike) and a consumer created later is
  born paused. A modified client cannot speak or hear through either.
- **Overrides outlive membership.** The runtime keeps a
  `moderationOverrides` map for its lifetime: leaving and rejoining (or
  a page refresh via the self-healing join) re-applies the flags and the
  published join state carries them. The map goes when the runtime does
  — once a room empties and is destroyed, the overrides reset. Nothing
  is persisted to the database.
- `voice.updateState` refuses to lift an active override and refuses a
  connection whose session was evicted (stale markers after a channel
  delete / group removal / moderator disconnect).
- Client mirror: `updateVoiceUserState` mirrors serverMuted/deafened
  into the target's own `ownVoiceState` (toast + mic-button guard);
  without the mirror the target's UI runs split-brain against the SFU.

## Client notes (voice-provider)

`components/voice-provider/index.tsx` sequences device acquisition,
transport setup, and producer creation in a deliberately ordered flow
with ref mirrors for values read inside stale closures. Treat ordering
changes as suspect-by-default; verify against a real two-party call
(the e2e harness cannot join voice — Tier-3 roadmap item).

## Invariants

1. One voice session per user, enforced by self-heal on join.
2. Registry keys are kind-qualified; a bare numeric id is never a
   sufficient lookup key across the voice surface.
3. The socket ownership stamp — not account identity — decides whose
   close tears down a session.
4. Empty runtimes are destroyed (mediasoup resources are finite).
5. Voice state is in-memory only; nothing about live calls is persisted.
6. Every involuntary removal goes through `removeUserFromVoice` /
   `evictRuntime` so the leave is always published.
7. The server owner is never a moderation target.
