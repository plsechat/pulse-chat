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
roster state, and ephemeral screen-share preview thumbnails.

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

## Session lifecycle

**Join** (`voice.join` / `dms.voiceJoin`):
1. Self-heal: if the user is already in ANY runtime (stale session from
   a refresh), remove them first — a rejoin must clear the old session,
   not brick the user.
2. Get-or-create the runtime (init builds the mediasoup router; on init
   failure the runtime is destroyed, not leaked).
3. `addUser`, stamp the connection: `ctx.currentVoiceChannelId`
   (+ `currentDmVoiceChannelId` for DM calls), and
   `ctx.setWsVoiceKey(runtime.key)` on the socket.

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

**Teardown**: `removeUserFromVoice` removes the user and destroys the
runtime when it empties (frees the mediasoup router). Belt-and-braces:
`cleanup-orphan-voice` cron sweeps users with no live WS connection out
of all runtimes — a mid-refresh user may be swept during the gap; the
self-healing join makes that harmless.

## Media

- Codecs: H264 (packetization-mode 1) is listed before VP8 —
  hardware-encoder friendly; forcing H264 for screen share resolved
  severe encoder heat on macOS clients.
- Audio: opus with FEC/DTX/stereo/bitrate from operator config.
- Screen-share hover previews are a pull model: the sharer pushes a
  bounded JPEG data-URL periodically (`updateStreamPreview`, only while
  actually sharing); roster hover queries it (`getStreamPreview`,
  VIEW_CHANNEL-gated via `channelProcedure`, previews excluded). The
  thumbnail is dropped when sharing stops. Never fanned out.

## Moderation

`voice.moderateMember` (server-mute / server-deafen) and
`voice.disconnectUser`, gated on MANAGE_USERS via `serverProcedure`:

- Target resolved by user, DM calls explicitly excluded, and the
  target's channel must belong to the invoker's active server — the
  refusal message is identical to "not in voice" so moderators can't
  probe other servers' voice occupancy.
- serverMuted also pauses the target's audio producer at the SFU — the
  mute is enforced server-side, not advisory client state.
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
