# Pulse Chat v0.2.0 — Identity verification + federation hardening

Released: 2026-05-04

## TL;DR

This release brings Pulse a step closer to genuine Signal-grade end-to-end encryption with a complete identity-verification flow, and re-shapes the federation wire format to close the abuse and replay vectors flagged in the May 2026 security audit. Per-peer safety numbers, an identity-changed modal, and a Verify Identity settings page now live alongside a JWT-based federation protocol that binds every signed request to its body hash, audience, and a unique `jti` for replay tracking.

> [!WARNING]
> **Breaking change for federation.** A v0.2 server cannot federate with a pre-v0.2 peer — the signed-request format is incompatible by design. If you operate federated instances, coordinate the upgrade with your peers before deploying.

---

## Headline features

### Identity verification (Phase C)

Up until v0.2, Pulse's `isTrustedIdentity` always returned `true`, which meant a malicious home server could hand any client a fake prekey bundle for a peer and read every "encrypted" message between them. v0.2 closes that gap end-to-end.

- **Trust on first use (TOFU).** The first time your client establishes a session with a peer, their identity public key is silently pinned. Subsequent sessions must match the pinned key.
- **Per-peer safety numbers.** Open `Settings → Verify Identity` to see the Signal-style 60-digit safety number for each pinned peer. Compare with them through any trusted channel — phone call, in person, signed paper — and click `Mark as verified` to upgrade their pin.
- **Identity-changed modal.** If a peer's key rotates without an authoritative broadcast, the next session attempt fails loudly with a modal listing the new safety number and three actions: `Accept new identity`, `Verify now` (jumps straight to the safety-number screen), or `Block this user`. The retry happens automatically once you accept.
- **Auto-accept on legitimate resets.** When a peer broadcasts an `E2EE_IDENTITY_RESET` event (e.g., they generated new keys deliberately), your client silently re-pins so you don't get nagged for every legitimate rotation.
- **Verified badges across the app.** DM 1:1 headers show a green `ShieldCheck` for manually-verified peers; channel member panels show a small green dot next to verified members; an amber warning triangle appears wherever a peer's identity changed recently and hasn't been re-verified.
- **Per-instance scope.** Each federated instance keeps its own pinning store — a federated user with id 5 isn't conflated with your home user id 5.

### Federation security overhaul (Phase 4)

Every signed federation request now carries body-hash, issuer, audience, and replay-tracking claims:

- `sha256` claim binds the JWT to the canonicalized request body. A field tampered with in transit fails verify.
- `iss` is checked against the claimed sender domain. Signatures can't be reused across instances.
- `aud` is the recipient domain. A signature signed for peer A can't be replayed against peer B.
- `jti` is a random uuid retained for 10 minutes. The same signature can't be replayed within the window.
- 5-minute TTL with explicit `iat`/`exp` so stale signatures expire.

Plus a stack of additional federation hardening:

- **Outbound rate limit** — 60/min per peer host, enforced at the fetch boundary. Stops a runaway loop or hostile peer from hammering a single remote.
- **Bounded image fetch** — federated avatar/banner downloads are streamed with a 10 MB cap and magic-byte sniffed (PNG / JPEG / GIF / WebP only). Closes the disk-fill and MIME-confusion vectors.
- **Verify-before-create** — `ensureShadowUser` now signs a `/federation/user-info` request to the named peer and accepts the remote's `name` as authoritative. Local users can no longer spam shadow records with arbitrary metadata.
- **`listInstances` permission gate** — federation peer membership now requires `MANAGE_SETTINGS`. Any authenticated user could previously enumerate the full peer table including pending and blocked instances.
- **Federated user management refused** — ban/kick/add-role/remove-role refuse federated targets at the route boundary. Admins manage federated users on their home instance, or block the federated INSTANCE entirely via `federation/block-instance`.
- **DNS re-validation at the fetch boundary** — every outbound federation fetch goes through `validateFederationUrl` again, closing the long-window TOCTOU between caller validation and TCP connect.
- **Abort timeout on relay** — `relayToInstance` is bounded at 10s.
- **Backfilled drizzle 0014 snapshot** — fixes the CI-only migration loop that was generating duplicate ALTER COLUMN statements.

---

## Reliability

- **SKDM-arrival auto-retry.** Group messages that arrived before their sender-key distribution message used to get stuck on `[Unable to decrypt]` after the bounded retry exhausted. Now any incoming SKDM walks Redux state for messages from that sender that previously failed and re-runs decrypt automatically. No more hard-refresh-to-fix.
- **Federated multi-store redistribute on identity reset.** After resetting your encryption keys, redistribution now iterates home + every connected federated instance, scoped to that instance's own ownUserId via the new `users.getMyId` route.
- **Verified-identity reads scoped to the active store.** Switching to a federated server no longer shows misleading verification badges — the Verify Identity page and `useVerifiedIdentity` hook both resolve against the active store, so federated user id 5 isn't conflated with home user id 5.
- **Bounded IDB plaintext cache.** The persistent plaintext cache used for sender-key re-fetch idempotency was unbounded; it now caps at 10,000 entries with lazy compaction every 500 writes (and once at module load to prune what previous sessions left).

---

## UI polish

- **Encryption padlock unified.** Channel headers and channel message rows previously rendered the encryption icon with a green-aura/glow style; DMs used a clean variant. All views now use the clean variant.
- **DM timestamps match channels.** Was relative ("22 minutes ago", green); now absolute ("Today at 14:30", muted grey, hover-reveal). Mirrors the channel format exactly.
- **Composer icon alignment.** The +/GIF/Send buttons are now vertically centered with the text baseline in single-line mode and anchored to the first line in multiline mode (where they group visually with the emoji button inside the input).
- **Hover animations on user controls.** Discord-style cues: the microphone wiggles, headphones jiggle, and the settings cog spins on hover. Pure CSS keyframes, gated by `prefers-reduced-motion`.
- **Verify Identity entry in the user popover.** Click any user's avatar to reach the safety-number screen for that peer in one step.

---

## What didn't make the cut

- **Encrypted cross-instance DMs.** DMs between users on different federated servers remain plaintext-with-banner (the L9 honest-marketing fix). Implementing this requires a per-instance lazy-presence model or a cross-server prekey relay protocol — substantial protocol design work, deferred to a future feature release.
- **Full DNS pinning for federation fetches.** The current re-validation at the fetch boundary closes the long-window TOCTOU but a small window remains between the DNS lookup and the TCP connect. Closing that window completely needs a custom undici dispatcher with IP pinning, which is environment-specific to Bun's native fetch and tracked as a follow-up.
- **Encrypted reactions.** Emoji on E2EE messages is still plaintext on the server. Bolted-on for a later release.

---

## Upgrading from v0.1.x

| | |
|---|---|
| Self-hosted single instance | Pull the new image and restart. Client-side IDB upgrades to v6 automatically on first page load. The new `verifiedIdentities` table is created empty — existing peers TOFU on first observation. |
| Self-hosted federated cluster | **Coordinate with peers.** Federation between v0.2 and pre-v0.2 will fail at signature verification with a 401 "Invalid signature". Schedule a synchronized cutover. |
| End-users | No action required. Identity pinning happens silently on first session establishment. Optionally, open `Settings → Verify Identity` after upgrade to compare safety numbers with anyone you want to manually verify. |

There are no DB migrations beyond what shipped in v0.1.7 — the missing `meta/0014_snapshot.json` artifact is backfilled in this release, which fixes the CI test job that had been failing since the Phase B push.

---

## Test coverage

- 9 new federation challenge tests (canonicalize order-independence, sign/verify round-trip, body tampering, iss mismatch, aud mismatch, replay, garbage signature, wrong public key)
- 9 new store-scoping tests for `verifiedIdentities` (per-instance isolation, listVerifiedIdentities scope, clear isolation, accept/manual lifecycle)
- New plaintext-cache compaction test (fills 10,500 rows, drives 500 writes through the persist API, verifies pruning to 8,000 with smallest-id rows evicted first)
- 9 magic-byte sniff tests for the federation image-fetch helper
- 5 outbound rate-limit tests (burst-of-60-passes, 61st-rejected, per-host-isolation, reset-clears, refill-over-time)
- New `users.getMyId` route tests
- F9 federated-target guard tests on ban/kick/addRole/removeRole

---

## Known issues

- **`@privacyresearch/libsignal-protocol-typescript@0.0.16` is unaudited.** Phase B and C added Ed25519 signing and TOFU pinning on top via WebCrypto, reducing reliance for the chain and verification layers — but X3DH session establishment still trusts the library.
- **In-memory replay tracking is single-process.** The `jti` cache for federation requests lives in process memory; a clustered deployment would need to share replay state. Single-process operation is unaffected.

---

[AGPL-3.0](LICENSE) · [GitHub repo](https://github.com/plsechat/pulse-chat) · [Self-hosting guide](README-SELFHOSTED-SUPABASE.md)
