# Pulse Chat v0.2.3 — Local auth, native SSO, federated channels

Released: 2026-07-09

## TL;DR

Pulse no longer needs Supabase. A new built-in **local auth backend** (bcrypt + HS256 sessions with silent refresh) means the only dependency is PostgreSQL — and the Docker `local` profile bundles even that. **Native OpenID Connect SSO** works against any IdP (Authentik, Keycloak, Zitadel, Auth0, …) under either auth backend, with per-method registration switches for SSO-only or invite-only instances. **Federated E2EE channels** (Phase E) land, alongside a systemic fix for local/federated ID collisions, custom status text, a click-to-focus screen-share UX, structured debug logging, and a new default port (**5443**).

> [!NOTE]
> v0.2.3 federates with v0.2.2 — no wire-format break this time. New cross-instance fields (`serverPublicId` event scoping, custom status sync) degrade gracefully against older peers. The pre-v0.2 federation incompatibility from v0.2.0 still applies.

---

## Headline features

### Local auth backend — no more Supabase requirement

Set `AUTH_BACKEND=local`, provide an `AUTH_SECRET` (≥32 chars), and Pulse handles authentication itself: bcrypt password hashing (`local_auth_users` table) and HS256-signed session tokens, straight against your Postgres database.

- **Quickest path from zero**: `docker compose --profile local up -d` — the profile bundles a `postgres:16-alpine` container. Pulse comes up on `http://localhost:5443` and the first registered user becomes the operator.
- **Session refresh.** Access tokens (7 days) silently renew from rotating refresh tokens (sliding 30-day window) via the new `POST /auth/refresh` endpoint. Tokens carry a `typ` claim so a refresh token can never be used as a session credential; pre-upgrade sessions keep working until they age out.
- **Supabase mode is unchanged** — still the path for Google / Discord / Facebook / Twitch social logins. Both backends share one schema and federate with each other freely.

### Native OpenID Connect SSO

Pulse now runs the OIDC flow itself (authorization-code + PKCE), so SSO works under **both** auth backends with no Supabase involvement:

- Endpoint discovery via `.well-known/openid-configuration`; `id_token` verified against the IdP's JWKS (or HS256 with the client secret for providers without a signing certificate), with issuer / audience / nonce checks.
- Sessions are Pulse-minted HS256 tokens signed with `AUTH_SECRET`.
- Configure with `OIDC_OAUTH_ENABLED`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_SECRET`, and an optional `OIDC_LABEL` for the login-button text. Register `<your-pulse-url>/auth/oidc/callback` in your IdP.

### Registration, your way

Per-method signup switches (all default on; a valid invite always bypasses):

- `REGISTRATION_DISABLED=true` — no self-registration at all
- `REGISTRATION_PASSWORD_ENABLED=false` — SSO-only instances; the Create Account form disappears from the login screen entirely
- `REGISTRATION_OIDC_ENABLED` / `REGISTRATION_SOCIAL_ENABLED` — per-method equivalents

### Federated E2EE channels (Phase E)

Server channels with E2EE enabled now work across federation. Sender-key distribution is addressed by globally-unique user/channel `publicId`s; SKDMs for remote members are stored host-side with an availability notification to the member's home instance (the member's client pulls and decrypts against its home identity). Status and profile changes (name, bio, banner color, avatar/banner) now sync to peer instances in real time instead of going stale.

### Systemic local/federated ID-collision fix

Numeric ids are instance-local — a federated server's channel or server can share your home server's id 1. A family of UI corruptions followed (voice glow on the wrong channel, the rail voice badge on the wrong server icon, kicks over a federated connection removing the wrong entry from the joined list). v0.2.3 makes `publicId` the identity for anything that crosses instances or survives a server switch:

- Voice-active channel and voice-hosting server are matched by publicId
- `USER_JOIN` / `USER_DELETE` / `USER_KICKED` / `SERVER_MEMBER_LEAVE` events carry `serverPublicId` and clients scope on it (numeric fallback for older peers)
- `channels.public_id` and `users.public_id` are backfilled and enforced `NOT NULL` at the DB level (migration `0019`, idempotent)

---

## Quality of life

- **Custom status text.** Set a short presence line ("🎧 working late") from the status dropdown in the user bar — up to 128 chars, persisted like your bio, shown under your name in the member list, profile popover, and DM panel. Syncs across federation.
- **Click-to-focus screen shares.** Click any share tile to focus it (no more hunting for the pin icon), `Esc` unfocuses, double-click a focused share for true browser fullscreen — and when someone starts sharing, their share focuses automatically without ever stealing a pin you set deliberately. Same behavior in DM calls.
- **Server logo and name changes** now update live across all connected clients (previously stale until refresh).
- **Default port changed 4991 → 5443.** Fresh installs use 5443; existing instances keep whatever `port` their `config.ini` sets.
- **Three purpose-built env templates** replace the one-size-fits-all example: `.env.local.example`, `.env.supabase-public.example`, `.env.supabase-local.example` — each fully commented.

## Operations & debugging

- **Structured debug logging** (`DEBUG_LOGGING=true`): JSON events to `log/debug.log` with size rotation (`DEBUG_LOG_MAX_SIZE_MB` / `DEBUG_LOG_MAX_FILES`), per-request correlation ids (`X-Pulse-Request-Id`), and auto-instrumentation across tRPC, federation, WebSocket, pubsub, and the DB layer.
- **Multi-arch Docker images** (`amd64` + `arm64`) published to `ghcr.io/plsechat/pulse-chat`.
- **LAN federation** for homelab setups: `FEDERATION_ALLOW_PRIVATE_CIDRS=192.168.1.0/24` allowlists private ranges that are otherwise blocked as SSRF targets.
- Compose hardening: the app container now waits for bundled-Postgres health, and registration/OIDC/debug env vars pass through correctly.
- Config precedence fixed: environment variables now override `config.ini` values (previously the INI merge could win).
- Faster auth checks: per-request user lookups replaced with an in-memory banned cache.
- A new CI job applies every DB migration twice to enforce the idempotency the boot-replay pattern requires.

## Fixes

- E2EE: concurrent SKDM distribution deduplicated on client and server (duplicate-session race).
- OIDC: `/auth/provision` no longer re-provisions stale OIDC sessions (401 instead, client clears the session).
- Debug log: numeric-key pollution and ANSI escapes stripped from JSON output.
- Test infrastructure: the recurring between-test flake family (deadlocks / duplicate-key seeds / ended connections) eliminated at the mechanism level — background write queues drain before each test, the DB reset is a single atomic transaction, and publishers can no longer fail unrelated tests as unhandled rejections.

---

## Upgrading from v0.2.x

| | |
|---|---|
| Self-hosted single instance | Pull the new image and restart. Migrations `0019` (publicId NOT NULL backfill) and `0020` (custom status) run automatically and are idempotent. Existing sessions survive: local-auth tokens minted before the `typ` claim are accepted until they age out (≤30 days). |
| Port | Existing `config.ini` values win — nothing changes unless you delete your config. Fresh installs listen on `5443`; update reverse-proxy/firewall rules accordingly. |
| Supabase deployments | No action. `AUTH_BACKEND` defaults to `supabase` when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are present. |
| Federated cluster | v0.2.3 ↔ v0.2.2 federation works; new fields degrade gracefully. Upgrade peers at your convenience for federated E2EE channels, custom-status sync, and publicId event scoping to be effective end-to-end. |
| End-users | No action required. |

---

## Test coverage

- Local auth backend: full round-trip suite plus refresh-token rotation, refresh-as-access rejection (both directions), legacy untyped-token compat, and forgery/garbage rejection
- Roster event scoping: kick publishes `USER_KICKED` / `SERVER_MEMBER_LEAVE` / `USER_DELETE` with `serverPublicId`; join publishes `USER_JOIN` with it
- Custom status: persist/clear round-trip, over-length rejection
- OIDC: provision/callback flows including the stale-session 401 path
- New migrations-idempotent CI job (every migration applied twice)

## Known issues

- **`@privacyresearch/libsignal-protocol-typescript@0.0.16` is unaudited** (unchanged from v0.2.0) — X3DH session establishment still trusts the library.
- **Local-auth refresh tokens are stateless.** There is no server-side revocation store yet; a stolen refresh token is valid until expiry (≤30 days). Rotating `AUTH_SECRET` invalidates every session immediately if needed.
- **OIDC sessions don't refresh.** They expire after 7 days and re-authenticate through the IdP — by design for this release.

---

[AGPL-3.0](LICENSE) · [GitHub repo](https://github.com/plsechat/pulse-chat) · [Self-hosting guide](README-SELFHOSTED-SUPABASE.md)
