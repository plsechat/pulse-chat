# E2EE sender keys — the SKDM state machine

How group conversations (server channels and group DMs) encrypt to many
recipients without N² pairwise encryption, and when chains rotate.
Client code: `apps/client/src/lib/e2ee/` (`index.ts` orchestrates;
`sender-keys.ts` = channel chains, `dm-sender-keys.ts` = DM chains,
`signal-protocol.ts` + `store.ts` = pairwise sessions and persistence).
Server code: `routers/e2ee/`, `routers/dms/sender-keys.ts` (opaque
storage + relay only — the server never sees plaintext or chain keys
outside SKDM envelopes it cannot open).

## Model

- **Pairwise layer (Signal-style)**: each user has an identity key,
  a signed prekey, and one-time prekeys (X3DH). Pairwise sessions
  encrypt only *control* material, never messages.
- **Group layer (sender keys)**: each sender owns an outbound chain per
  conversation (`senderKeyId` + chain key). Messages are encrypted once
  with the chain; the chain is announced to every other member via a
  **Sender Key Distribution Message (SKDM)** encrypted pairwise.
- **Single-device keying is the contract**: one identity key per user,
  held by one browser profile. A second device (or a cleared browser)
  restoring from backup *replaces* the identity; two devices never
  share one. History encrypted before the replacement stays readable
  only where the old identity's store survives.
- Identity verification is TOFU with explicit verification on top
  (identity changes surface as warnings; `decrypt-retry.ts` +
  `identity-change-dispatch.ts` handle re-sync after a peer rotates).
  Safety numbers hash the two users' **home publicIds** with their
  identity keys — never numeric user ids, which are instance-local and
  would give a federated pair two different numbers for one genuine
  key pair. A shadow user's home id reaches the client as
  `federatedPublicId`; `stablePublicIdOf` picks it.
- **Who may read whose keys**: `e2ee.getPreKeyBundle` and
  `e2ee.getIdentityPublicKey` answer when the caller and the target
  share a server, share a DM channel, or are friends
  (`canReadKeysOf`). Friends who met outside any server can therefore
  open and actually use an encrypted DM; strangers get FORBIDDEN and
  consume no one-time prekey.

## Chain states and transitions

A sender's outbound chain for a conversation is in one of:

1. **Absent** — never sent. First send creates the chain
   (`getOrCreateOutboundChannelChain`) and distributes SKDMs to all
   current members.
2. **Established** — chain exists, members hold the SKDM. Sends just
   ratchet the chain. A newly added member receives the *existing*
   chain via SKDM (added members may read history from join onward —
   forward secrecy against removed members is the goal, not backward).
3. **Dirty** — a member was removed (kick/leave/ban). The subscription
   handler only sets a per-conversation dirty marker
   (`store.isChainDirty` / `markChainDirty`); nothing rotates yet.
4. **Rotated (lazy)** — on the NEXT send with a dirty chain:
   bump `senderKeyId`, generate a fresh chain
   (`rotateOutboundChannelChain` / `rotateOutboundDmChain`), clear the
   marker, invalidate the member cache, distribute SKDMs to the
   *current* member list only. The removed member never receives the
   new chain — that is the security property. DM groups can also
   rotate eagerly (`rotateDmGroupSenderKey(remaining)`).

**Identity rotation** (user resets/replaces their identity): rotate the
chain FIRST, then re-SKDM — peers must get a brand-new chain under the
new identity, never a re-send of the old chainKey. Federated peers are
told via `/federation/identity-rotation-broadcast`.

The same-instance fan-out (`registerKeys` → `E2EE_IDENTITY_RESET`) goes
only to users who hold something from the resetter: every viewer of one
of the resetter's E2EE channels and every member of an E2EE DM with
them — not every co-member of every shared server. Each recipient's
payload carries `channelIds`, the E2EE channels *that recipient* shares
with the resetter (computed per recipient so nobody learns the ids of
private channels they cannot see; empty for DM-only peers, whose DM
chains re-send lazily on the next send), so the client re-keys exactly
those instead of listing and re-keying all of its own. The resetter's
own list comes from `getViewableE2eeChannelIds`, one statement over
channel + membership + role/user overrides with the same semantics as
`hasChannelPermission`; the `identity_reset` system rows are inserted
into that list and the E2EE DMs.

## Federation relay

A remote member's SKDM cannot be delivered locally, so the server
relays opaquely:

- `/federation/get-prekey-bundle` — fetch a remote user's X3DH bundle
  to open a pairwise session cross-instance.
- `/federation/dm-sender-key` — deliver a DM SKDM envelope to a remote
  member's home instance.
- `/federation/channel-sender-key-notify` — tell remote members a
  channel chain changed so they re-fetch.

These relays are dispatched fire-and-forget from
`routers/dms/sender-keys.ts` and `routers/e2ee/index.ts`; each `void`
call carries `.catch` (unguarded rejections here were a CI-flake
source — keep the handlers).

## What the server can still see

End-to-end encryption covers message bodies and attachment bytes.
Everything else about a conversation is plaintext to the server, to
anyone with database access, and to the federated peers that relay it.
All of this is current behaviour:

| Visible to the server | Where |
| --- | --- |
| Who talks to whom, when and how often — sender, channel / DM, timestamps, edit and delete events | `messages`, `dm_messages` rows |
| Reactions: the emoji and who reacted | `message_reactions`, `dm_message_reactions` (`messages.toggleMessageReaction`, `dms.toggleReaction`) |
| Pin state (`pinned`, `pinnedBy`, `pinnedAt`) | `messages` columns |
| Reply graph (`replyToId`) and thread membership | `messages` columns |
| Attachment count and size, plus whatever MIME type the client declares; the original filename is replaced by a UUID placeholder only when the client uploads with the `encrypted` flag | `files` rows (`http/upload.ts`) |
| Identity-reset system rows (`content: 'identity_reset'`) | `routers/e2ee/identity-reset-messages.ts` |
| Typing indicators | `messages.signalTyping` pubsub |
| Membership, roles and read state | the usual tables |

Three further caveats:

- **Threads inherit encryption; forum posts cannot be encrypted.** A
  thread created under an E2EE channel is an E2EE channel itself
  (`threads.createThread` copies the parent's flag), so its messages
  are enforced like the parent's. A forum post's opening message is
  plaintext by construction, so `threads.createForumPost` refuses to
  create posts under an encrypted forum rather than storing them in the
  clear.
- **Search excludes encrypted messages.** Channel search
  (`search.searchMessages`) and DM search (`dms.searchMessages`) both
  filter on `e2ee = false`; encrypted history is not searchable
  anywhere today.
- **One device per identity.** The server holds one identity key per
  user and the client UI says so; see invariant 5 below for what that
  means in practice.

The server also does not emit plugin events (`message:created` /
`message:updated`) for E2EE messages, so plugins never see ciphertext
either — they see nothing.

## Invariants

1. The server stores and relays only envelopes it cannot decrypt.
2. Chain rotation is lazy on send, triggered by the dirty marker; the
   marker — not the roster diff — is the source of truth for "must
   rotate".
3. SKDM distribution always targets the member list as of distribution
   time, never a cached pre-removal roster.
4. Identity rotation ⇒ chain rotation before any re-distribution.
5. **One identity per user — single-device keying is the contract.**
   The server stores exactly one identity key, one signed prekey set
   and one one-time-prekey pool per user; the browser profile that
   registered them is the only one that can decrypt. Signing in
   elsewhere means either restoring the key backup there (which
   *replaces* the identity: every peer sees an identity change and
   re-keys, and the previous profile's sessions are dead) or
   generating new keys with the same effect. Two profiles never share
   one identity, and nothing in the protocol fans a message out to a
   second device. Messages received before the replacement stay
   readable only where the old profile's IndexedDB survives.
6. Cross-instance E2EE identity is publicId-keyed, like all federation
   identity (see `federation.md`).
