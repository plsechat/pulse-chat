# Pulse Chat v0.3.0 — Run your instance: admin panel, reporting, and account controls

Released: 2026-07-22

## TL;DR

The operator release. Instance owners get a real **admin panel** — every account and server on the instance, **abuse reports**, live **health graphs** (CPU, memory, network), an **activity log**, storage tools, and a live **log tail**. Members get **abuse reporting** for messages, DMs, and accounts (routed to the right moderators), **self-service account deletion**, and **message forwarding** with tamper-proof "Forwarded from" attribution. Under the surface, the channel and DM chat stacks were unified into one shared implementation — which also closed a DM HTML-sanitization gap and fixed wrong-name resolution in federated DMs.

---

## Headline features

### Instance administration

A new owner-only admin area under Server Settings → Instance (home instance only):

- **All Accounts.** Every account on the instance, searchable, with instance-wide ban / unban and operator-forced deletion.
- **All Servers.** A directory of every server, its owner, and what it contains — with operator delete (the bootstrap server is protected, since instance ownership anchors on it).
- **Registration controls.** Toggle open registration and see the enabled sign-in methods.
- **Screen Sharing.** Set an instance-wide ceiling on screen-share resolution and framerate.
- **Review Queue.** The reports surface (see below).
- **Health.** Server and Bun versions, uptime, live WebSocket/voice occupancy, federation peers, and database/content/storage totals — plus **time-series graphs** for CPU (system and process), memory, network throughput, event-loop lag, and connections, sampled in-process every 15 seconds.
- **Activity Log.** The instance-wide audit trail with an event-type filter.
- **Storage.** Usage totals, orphaned-file backlog, heaviest uploaders, and a manual cleanup trigger.
- **Logs.** A live, level-filterable tail of the last 1,000 server log lines (in-memory — files never leave the box).

### Abuse reporting

- Report a **message, DM message, or user** from its context menu or profile.
- **Layered routing:** channel-message reports go to that server's moderators (gated by a new *Review reports* permission); DM and account reports — and anything escalated — go to the instance operator. Server-handled reports also appear to the operator as receipts.
- **Auto-escalation** for `illegal`-flagged reports and reports targeting a moderator; moderators can escalate manually, and unhandled reports escalate after a week.
- The reviewer sees **only the reported item** — a server-verified snapshot for plaintext, or the reporter's decrypted copy for end-to-end-encrypted messages (flagged as reporter-attested, since the server can't verify ciphertext). The admin panel never browses conversations.

### Account deletion

- Self-service deletion with a password (or typed-name) confirmation. Deletion **anonymizes**: your messages remain as "Deleted User" so conversations stay coherent, while your profile, cosmetics, memberships, friendships, and all E2EE key material are scrubbed. Blocked while you still own servers.

### Message forwarding

- Forward any message to channels or DMs. The forwarded copy is a **verbatim, non-editable** 1:1 of the original, and its **"Forwarded from" attribution is set by the server** from the source message — it can't be edited or faked. Works across channels, DMs, and federation (E2EE destinations excluded).

### Screen-share quality controls

- The instance operator sets a **global maximum resolution and framerate** for screen sharing (Server Settings → Instance → Screen Sharing). Members can pick any quality **at or below** the cap — the Stream Quality menu now spans the full ladder up to it, instead of just 720p/1080p — and the client clamps its capture to the ceiling.
- The screen-share hover controls (change source, fullscreen, stop) are **larger**, with proper touch targets.

### Sound & settings

- **Per-event notification sounds** with a live preview and a new default sound family; the volume slider now runs 0–200%.
- **Settings overhaul:** a *My Account* identity hub (email, sign-in method, password change, danger zone), a renamed *Personalization* tab, Voice & Video rebuilt on a consistent settings layout, and Server Settings reorganized as a sidebar.

### Voice moderation

- Server-mute and server-deafen are now reachable directly from the voice roster and grid tiles.

## Security & privacy

- **Scoped authorization builders.** Server-, channel-, and instance-owner-scoped tRPC procedures make permission and cross-server-scope checks part of the procedure type instead of something each handler must remember — closing a whole class of missed-check bugs. Instance-operator gating was tightened (e.g. federation key generation is now owner-only).
- **DM HTML sanitized.** Legacy-HTML DM messages are now DOMPurify-sanitized with an allowlist, matching channel messages (the DM path previously parsed raw).
- **Correct identity in federated DMs.** Mentions, custom emoji, and system messages inside DMs now resolve against your home instance, so they no longer show the wrong person while a federated server is open.
- Reproducible builds (committed lockfile, pinned Bun) and the server DB schema kept out of the browser bundle.

## Fixes

- The speaking indicator no longer overrides styled display names in the roster.
- The "(edited)" tag stays small on emoji-only messages.
- The non-friend DM banner respects a friend request already in flight — it stops nagging you to re-send, and when the other person requested *you*, Accept now accepts their request.
- Voice rooms for a DM and a server channel that happen to share a numeric id no longer collide.
- Opening **Voice Settings** from the microphone menu now lands on the Voice & Video tab instead of My Account.
- Fix round: a CI race fixed at the source, an E2EE edit path, stale DM display cosmetics, single-line code fences, fullscreen portal rendering, and preview-first register-with-invite.

## Under the hood

- New tables/columns via idempotent migrations: `reports` (0026), `users.deleted_at` (0025), `messages`/`dm_messages` `forwarded_from_*` (0027), `settings` screen-share caps (0028). Schema changes apply automatically on boot.
- **Chat UI unified.** The channel and DM message stacks now share one implementation under `chat-primitives` — message body, inline editor, scroll controller, reactions, typing indicator, and more — so chat fixes land once instead of twice.
- New `VIEW_REPORTS` permission; an in-process metrics sampler and log ring back the Health and Logs panels.
- Architecture deep-dives added under `docs/` (federation protocol, E2EE sender keys, voice).

## Upgrading

```bash
docker compose pull && docker compose up -d
```

No manual migration steps — schema changes apply automatically on boot. One cosmetic note: your DM scroll positions reset once on this upgrade (an internal key-format change); channel scroll positions are unaffected.
