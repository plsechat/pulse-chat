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
- **Single-device keying**: one identity per user. A second device
  restoring from backup replaces, not augments, the identity.
- Identity verification is TOFU with explicit verification on top
  (identity changes surface as warnings; `decrypt-retry.ts` +
  `identity-change-dispatch.ts` handle re-sync after a peer rotates).

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

## Invariants

1. The server stores and relays only envelopes it cannot decrypt.
2. Chain rotation is lazy on send, triggered by the dirty marker; the
   marker — not the roster diff — is the source of truth for "must
   rotate".
3. SKDM distribution always targets the member list as of distribution
   time, never a cached pre-removal roster.
4. Identity rotation ⇒ chain rotation before any re-distribution.
5. One identity per user (single-device keying); restore replaces.
6. Cross-instance E2EE identity is publicId-keyed, like all federation
   identity (see `federation.md`).
