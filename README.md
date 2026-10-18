<p align="center">
  <img src="https://raw.githubusercontent.com/plsechat/pulse-chat/main/apps/client/public/logo.png" alt="Pulse Chat" width="100" />
</p>

<h1 align="center">Pulse Chat</h1>

<p align="center">
  A self-hosted chat platform built for privacy, voice, and connecting communities.
  <br />
  <a href="https://plse.chat"><strong>plse.chat</strong></a> &middot;
  <a href="README-SELFHOSTED-SUPABASE.md">Self-Hosting Guide</a> &middot;
  <a href="https://github.com/plsechat/pulse-chat/releases">Releases</a> &middot;
  <a href="https://github.com/plsechat/pulse-desktop">Desktop app</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License" /></a>
  <a href="https://github.com/plsechat/pulse-chat/commits"><img src="https://img.shields.io/github/last-commit/plsechat/pulse-chat" alt="Last Commit" /></a>
</p>

<!-- <p align="center"><img src="docs/screenshot.png" alt="Screenshot" width="720" /></p> -->

---

> [!NOTE]
> Pulse Chat is in alpha (v0.4.0). Expect bugs and breaking changes between updates.

> [!WARNING]
> **The federation wire format changed in v0.2.0.** Signed requests embed the request body's SHA-256 in a `sha256` JWT claim, plus `iss`/`aud`/`jti` claims for replay and cross-instance protection. A v0.2.x server **cannot** federate with a pre-v0.2 peer — both sides must be on v0.2 or newer.

## Why Pulse?

Pulse is a self-hosted alternative to Discord and Slack that puts you in control. Messages and attachments can be end-to-end encrypted (opt-in per channel or DM — see [what the server can still see](docs/e2ee-sender-keys.md#what-the-server-can-still-see)), voice and video stay on your infrastructure, and federation lets separate instances talk to each other — no central service required.

## What's included

| | |
|---|---|
| **Encrypted messaging** | Opt-in end-to-end encryption for DMs and channels (X3DH pairwise sessions + sender keys), with TOFU identity pinning and safety-number verification. One device per identity; metadata such as reactions, timestamps and file sizes stays visible to the server — see [docs/e2ee-sender-keys.md](docs/e2ee-sender-keys.md#what-the-server-can-still-see) |
| **Voice & video** | WebRTC-powered calls with screen sharing via Mediasoup |
| **Federation** | Link multiple Pulse instances so users can discover and join across servers |
| **Forum channels** | Threaded discussions with tags for long-form topics |
| **Channels & DMs** | Real-time text with file uploads, reactions, threads, mentions, polls and scheduled posts; deleted messages stay as a placeholder for a configurable time |
| **Announcement channels** | Channels only announcers post in, which other communities (on this instance or a federated peer) can follow |
| **Planner** | A community event planner: rosters with roles and a bench, reminders, an automatic private voice room around the event, and a calendar feed |
| **Soundboard** | Short clips per community that members play into a voice room |
| **Public directory** | Communities can list themselves; members browse listings from this instance and its federated peers |
| **Community import** | A wizard that brings channels, roles, emoji, history and attachments over from another chat service, with placeholder authors that merge when the real person signs in |
| **Roles & permissions** | Granular access control at the server, channel, and user level, with a role hierarchy |
| **Custom emojis** | Upload and manage emojis per server |
| **Automod** | Keyword filters, regex rules, mention limits, link blocking and timeouts |
| **Webhooks** | Push events to external services |
| **Plugins** | Extend the server with installable plugins via the plugin SDK: event hooks, slash commands, posting and reacting under the plugin's own account, channels, files, scheduled events, secret settings and signed HTTP endpoints. Two official plugins ship in the image, off by default: a chat bridge that mirrors a community to a server on another chat service in both directions, and watch-together for text channels and voice rooms |
| **Game presence** | With the desktop app, share what you are playing and see who plays what, per community |
| **OAuth & SSO login** | Google, Discord, Facebook, Twitch (Supabase mode), plus native OpenID Connect SSO — Authentik, Keycloak, Zitadel, Auth0, or any OIDC provider (works with either auth backend) |
| **Invite-only mode** | Lock down registration so only invited users can join |

## Getting started

Pulse runs against either of two auth backends — pick whichever fits:

| Backend | Needs | When to use |
|---|---|---|
| **`local`** (default) | Just PostgreSQL + an `AUTH_SECRET` | Single-node deployments, homelabs, anything where you don't want a SaaS dep. Email + password **and** native OIDC SSO (Authentik / Keycloak / …). No Supabase-mediated social logins. |
| **`supabase`** | Supabase Cloud or a self-hosted Supabase stack | Social OAuth providers (Google / Discord / Facebook / Twitch) and setups that already run Supabase. Native OIDC SSO works here too. |

Both modes share the same database schema and federate with each other — the auth backend choice is local to each instance.

### Quickest path — local auth + bundled Postgres

Spin up Pulse with its own PostgreSQL container, no SaaS required:

```bash
# Generate a session-signing secret (>=32 chars) and pin local mode
cat > .env <<EOF
AUTH_BACKEND=local
AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
EOF

docker compose --profile local up -d
```

Pulse listens on `5443`; the bundled `postgres:16-alpine` is on `5432`. Open `http://localhost:5443` and the first user to register becomes the operator.

### Docker (existing Postgres / Supabase)

```bash
docker run \
  -p 5443:5443/tcp \
  -p 40000:40000/tcp \
  -p 40000:40000/udp \
  -v ./data:/root/.config/pulse \
  -e AUTH_BACKEND=local \
  -e AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')" \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dbname \
  --name pulse \
  ghcr.io/plsechat/pulse-chat:latest
```

For Supabase mode (OAuth, hosted auth) bundled with Pulse, use [docker-compose-supabase.yml](docker-compose-supabase.yml) — see the [Self-Hosted Guide](README-SELFHOSTED-SUPABASE.md).

### Linux binary

```bash
curl -L https://github.com/plsechat/pulse-chat/releases/latest/download/pulse-linux-x64 -o pulse
chmod +x pulse
export AUTH_BACKEND=local
export AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
export DATABASE_URL=postgresql://user:pass@localhost:5432/pulse
./pulse
```

### Deployment model

Run **one Pulse process per database**. Realtime fan-out (pub/sub), the banned-user cache, the in-flight upload registry and plugin state all live in that process's memory, and the voice SFU binds its media port locally. A second process pointed at the same database would not share any of that: its users would miss events, bans and uploads made through the other one. Scale vertically (CPU, RAM, bandwidth — and cap voice with `MEDIASOUP_MAX_PARTICIPANTS` if needed); horizontal scaling behind a load balancer is not supported.

### After first launch

1. Open `http://localhost:5443` and register.
2. The **first account registered becomes the instance operator** — owner of the bootstrap server, with every permission. Later registrations are regular users. There is no token to claim and nothing prints to the console.
3. To hand the instance to someone else later, use **Server Settings → Users → Transfer Ownership** (the `servers.transferOwner` procedure).

## Configuration

### Environment

| Variable | Required when | What it does |
|---|---|---|
| `AUTH_BACKEND` | always (defaults inferred) | `local` or `supabase`. Defaults to `supabase` if `SUPABASE_URL` is set, else `local`. |
| `AUTH_SECRET` | `AUTH_BACKEND=local` | ≥32 random chars; HS256 signing key for session tokens. Access tokens live 15 minutes and renew silently from a 30-day refresh token. Logging out or changing the password revokes the session server-side (a password change keeps the current device signed in). **Rotating the secret still invalidates every session.** |
| `DATABASE_URL` | always | Full Postgres connection string |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | `AUTH_BACKEND=supabase` | Managed or self-hosted Supabase Auth |
| `SUPABASE_PUBLIC_URL` | `AUTH_BACKEND=supabase` when `SUPABASE_URL` is an internal hostname | Browser-facing Supabase URL handed to the client via `/info`. Falls back to `SUPABASE_URL`; the bundled compose sets it from `SITE_URL`. |
| `PUBLIC_IP` | production behind NAT | Public IP (or hostname) announced to voice clients as the media address. Auto-detected when unset. |
| `MEDIASOUP_PORT` | optional | The single voice media port, UDP **and** TCP (default `40000`). Map/open exactly this port in both protocols. |
| `MEDIASOUP_MODE` | optional | `single-port` (default) or `range`. Range mode binds one UDP and one TCP port per transport from `MEDIASOUP_RTC_MIN_PORT`–`MEDIASOUP_RTC_MAX_PORT` (default `40000`–`40020`) — the pre-0.4 behaviour, for networks that depend on it; it caps the instance at about half the range size in participants. |
| `MEDIASOUP_MAX_PARTICIPANTS` | optional | Instance-wide cap on concurrent voice participants across every channel and DM call; joins beyond it are refused with "Voice capacity reached". Default `0` = unlimited. |
| `WEBRTC_TURN_URLS` | optional | Comma-separated `turn:` / `turns:` (or `stun:`) URLs of a relay for clients that cannot reach the media port directly (at most 8). Handed to clients via `/info`; Pulse itself never needs a relay. See [docs/voice.md](docs/voice.md#networking). |
| `WEBRTC_TURN_USERNAME` / `WEBRTC_TURN_CREDENTIAL` | optional | Relay credentials. They are sent to every client, so use time-limited TURN credentials or a relay you control. |
| `WEBRTC_ICE_TRANSPORT_POLICY` | optional | `all` (default) or `relay` to force every client through the relay (diagnostics / locked-down networks). |
| `REGISTRATION_DISABLED` | optional | Lock down registration instance-wide (all methods; invites still work) |
| `REGISTRATION_PASSWORD_ENABLED` / `REGISTRATION_OIDC_ENABLED` / `REGISTRATION_SOCIAL_ENABLED` | optional | Per-method signup switches (default `true`). Set to `false` to disable that method's self-registration; a valid invite still bypasses it. For OIDC-only signups, set the password + social ones to `false`. |
| `FEDERATION_ALLOW_PRIVATE_CIDRS` | optional | Comma-separated IPv4 and IPv6 CIDRs to allow as federation peers (e.g. `192.168.1.0/24,fd00::/8`). Default: all RFC1918 / ULA / loopback / link-local blocked. Listing `127.0.0.0/8` also admits `::1`, so `localhost` peers work without a separate v6 entry. Allowlisted IP-literal and bare-hostname peers are dialled over plain HTTP. |
| `OIDC_OAUTH_ENABLED` | optional | Set `true` to enable native OpenID Connect SSO (works under either auth backend). See [Single Sign-On (OIDC)](#single-sign-on-oidc). |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_SECRET` | `OIDC_OAUTH_ENABLED=true` | Your IdP's issuer URL and client credentials. Endpoints are discovered at `<issuer>/.well-known/openid-configuration`. |
| `OIDC_LABEL` | optional | Login-button text (default `Single Sign-On`) |
| `OIDC_REDIRECT_URI` | optional | Overrides the auto-derived `<pulse-url>/auth/oidc/callback` |
| `GOOGLE_OAUTH_ENABLED` / `DISCORD_OAUTH_ENABLED` / `FACEBOOK_OAUTH_ENABLED` / `TWITCH_OAUTH_ENABLED` | `AUTH_BACKEND=supabase` | Toggle each Supabase-mediated social provider |
| `GIPHY_API_KEY` | optional | Enables GIF search in the composer |
| `TRUST_PROXY` | behind a reverse proxy | Trust `X-Forwarded-*` headers for client IP / protocol. The client address is the **rightmost** `X-Forwarded-For` hop (the one your proxy appended); invalid values fall back to the socket address. |
| `TRUST_PROXY_HEADER` | optional | `cf-connecting-ip` or `x-real-ip`: trust that single header for the client address instead of `X-Forwarded-For`. Only set it when your proxy is guaranteed to OVERWRITE that header (Cloudflare, or nginx with `proxy_set_header X-Real-IP $remote_addr`); a proxy that merely forwards it lets clients spoof their address. |
| `PUBLIC_URL` | optional | The origin clients reach Pulse on (e.g. `https://pulse.example.com`). Wins over `Host` / `X-Forwarded-*` when deriving redirect URIs, cookie flags and HSTS; set it when Pulse cannot see the public scheme (no `TRUST_PROXY`, TLS terminated elsewhere). HSTS is sent only when the resolved scheme is `https`. |
| `WS_MAX_CONNECTIONS_PER_IP` / `WS_MAX_CONNECTIONS_PER_USER` | optional | Open WebSocket caps — default `20` per client address and `10` per account; the socket over the cap is closed with code `1008`. Raise the per-IP cap behind a shared NAT. |
| `WS_CONNECTION_PARAMS_TIMEOUT_MS` | optional | A socket that sends no connection params within this window is closed (default `10000` ms). |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | optional | Per-IP budget for the auth endpoints — default 10 requests per 15 minutes (`900000` ms). Raise `AUTH_RATE_LIMIT_MAX` behind a shared NAT. |
| `DEBUG_LOGGING` | optional | Write JSON debug events to `logs/debug.log` under the data directory (`DEBUG=true` / `DEBUG=1` is accepted as a backward-compatible alias) |
| `DEBUG_LOG_MAX_SIZE_MB` / `DEBUG_LOG_MAX_FILES` | optional | Rotation limits for `debug.log` (used with `DEBUG_LOGGING`) |
| `DEBUG_LOG_INCLUDE_BODY` | optional | Set `false` to strip request bodies from debug events (default `true`) |
| `REDACT_EXTRA` | optional | Comma-separated extra keys to redact in logs, on top of the built-in secret/token denylist |
| `TOMBSTONE_RETENTION_DAYS` | optional | Days a deleted message stays as a "Message deleted" placeholder before a daily job removes the row (default `30`; `0` keeps the placeholders forever). Overrides `server.tombstoneRetentionDays` below. |

The debug/redaction, retention, voice-networking and TURN variables override the matching `config.ini` keys below; env always wins over the INI file.

Full, commented templates — copy the one that matches your setup to `.env`:

- [.env.local.example](.env.local.example) — local backend, no Supabase (the default path above).
- [.env.supabase-public.example](.env.supabase-public.example) — `AUTH_BACKEND=supabase` against a managed/external Supabase project.
- [.env.supabase-local.example](.env.supabase-local.example) — the bundled self-hosted Supabase stack (`docker-compose-supabase.yml`); see the [Self-Hosted Guide](README-SELFHOSTED-SUPABASE.md).

### config.ini

`config.ini` is generated on first run in the Pulse data directory, which also holds uploads, logs and plugins:

- Linux: `$XDG_CONFIG_HOME/pulse` (default `~/.config/pulse`) — the Docker image mounts this as `/root/.config/pulse`
- macOS: `~/Library/Application Support/pulse`
- Windows: `%APPDATA%\pulse`
- running from source (`bun run dev`): `apps/server/data/`

| Section | Key | Default | What it does |
|---|---|---|---|
| server | `port` | `5443` | HTTP / WebSocket port |
| server | `debug` | `false` | Debug logging (`DEBUG_LOGGING=true` overrides) |
| server | `debugLogMaxSizeMb` | `200` | Rotate `debug.log` at this size in MB (`DEBUG_LOG_MAX_SIZE_MB` overrides) |
| server | `debugLogMaxFiles` | `10` | Rotated debug-log files to keep (`DEBUG_LOG_MAX_FILES` overrides) |
| server | `debugLogIncludeBody` | `true` | Include request bodies in debug events (`DEBUG_LOG_INCLUDE_BODY=false` overrides) |
| server | `redactExtra` | — | Extra keys to redact in logs; INI list syntax `redactExtra[]=key` (`REDACT_EXTRA` overrides) |
| server | `retentionDays` | `90` | Days to keep sign-in records (`logins`) and the audit trail (`activity_log`); a daily job deletes older rows. `0` keeps them forever |
| server | `tombstoneRetentionDays` | `30` | Days a deleted message stays as a "Message deleted" placeholder (its row, with who deleted it and when; content and attachments are gone at once) before a daily job removes the row. `0` keeps the placeholders forever (`TOMBSTONE_RETENTION_DAYS` overrides) |
| mediasoup | `worker.mode` | `single-port` | `single-port`: every transport multiplexes over `worker.port`; `range`: one UDP + one TCP port per transport from the range below (`MEDIASOUP_MODE` overrides) |
| mediasoup | `worker.port` | `40000` | The voice media port, UDP and TCP (`MEDIASOUP_PORT` overrides) |
| mediasoup | `worker.rtcMinPort` | `40000` | Range mode: port range start; also used by plugin RTP ingest transports (`MEDIASOUP_RTC_MIN_PORT` overrides) |
| mediasoup | `worker.rtcMaxPort` | `40020` | Range mode: port range end (`MEDIASOUP_RTC_MAX_PORT` overrides) |
| mediasoup | `maxParticipants` | `0` | Instance-wide concurrent voice participant cap, `0` = unlimited (`MEDIASOUP_MAX_PARTICIPANTS` overrides) |
| mediasoup | `audio.maxBitrate` | `510000` | Opus max bitrate (bps) |
| mediasoup | `audio.stereo` | `true` | Opus stereo |
| mediasoup | `audio.fec` | `true` | Opus in-band forward error correction |
| mediasoup | `audio.dtx` | `true` | Opus discontinuous transmission (silence suppression) |
| mediasoup | `video.initialAvailableOutgoingBitrate` | `10000000` | Initial estimated outgoing bandwidth per transport (bps) |
| webrtc | `turn.urls[]` | — | TURN relay URLs for clients that cannot reach the media port; INI list syntax `urls[]=turn:…` (`WEBRTC_TURN_URLS` overrides) |
| webrtc | `turn.username` / `turn.credential` | — | Relay credentials, handed to every client (`WEBRTC_TURN_USERNAME` / `WEBRTC_TURN_CREDENTIAL` override) |
| webrtc | `iceTransportPolicy` | `all` | `relay` forces clients through the relay (`WEBRTC_ICE_TRANSPORT_POLICY` overrides) |
| federation | `enabled` | `false` | Turn on federation |
| federation | `domain` | — | Your public domain (required for federation) |
| federation | `allowUserFederatableServers` | `false` | `true` lets any server owner mark their server federatable; otherwise only the instance owner can |
| federation | `exposeDirectory` | `true` | Whether `/federation/directory` answers peers with this instance's listed communities; the instance owner toggles it under Instance → Registration |

Upload limits (max file size, per-user quota, overflow action) are server settings edited in the admin UI, not `config.ini` keys.

Attachment links in private channels and DMs are signed and expire after 12 to 24 hours; the client refreshes them whenever it loads messages, so a copied link stops working once its window passes. Removing someone's access to a private channel (kick, ban, leaving, a role or permission change, or flipping the channel private) rotates that channel's signing key, so links they still hold stop resolving at once. Files in public channels and profile media (avatars, emojis, logos) are served without a token and cached by the browser indefinitely under their immutable names.

> [!IMPORTANT]
> **Voice port.** All voice media — every channel and DM call, send and receive — runs over **one port, `40000`, in both UDP and TCP** (`MEDIASOUP_PORT`). Map and open exactly that port for both protocols: UDP is preferred, TCP is the fallback for clients whose UDP is blocked. There is no per-port participant ceiling; use `MEDIASOUP_MAX_PARTICIPANTS` to bound voice load. Clients connect straight to `PUBLIC_IP` on that port — Pulse needs no STUN and runs no TURN relay; only clients that can reach it over neither UDP nor TCP need a relay, which you can point them at with `WEBRTC_TURN_URLS`. Existing deployments that mapped `40000-40020` keep working (the port lives inside the range); set `MEDIASOUP_MODE=range` only if your network relies on per-transport ports. See [docs/voice.md](docs/voice.md#networking).

## Single Sign-On (OIDC)

Pulse can authenticate against any standards-compliant OpenID Connect provider — Authentik, Keycloak, Zitadel, Auth0, and others. Unlike the social providers (which are mediated by Supabase), OIDC is handled by Pulse itself, so it works under **both** the `local` and `supabase` auth backends and needs no Supabase.

1. In your IdP, create an OAuth2 / OIDC application (confidential client) and set its redirect URI to:

   ```
   https://<your-pulse-url>/auth/oidc/callback
   ```

2. Add to your `.env` (and make sure `AUTH_SECRET` is set — it signs the session token):

   ```env
   OIDC_OAUTH_ENABLED=true
   OIDC_LABEL=Authentik                      # login-button text
   OIDC_ISSUER=https://auth.example.com/application/o/<app-slug>/
   OIDC_CLIENT_ID=your-client-id
   OIDC_SECRET=your-client-secret
   ```

   Pulse fetches `<OIDC_ISSUER>/.well-known/openid-configuration` to discover endpoints and verifies the `id_token` (RS256 via the provider's JWKS, or HS256 with the client secret when the provider has no signing certificate).

3. Restart Pulse. A button labeled `OIDC_LABEL` appears on the login screen. First-time users are provisioned automatically (subject to your registration / invite policy).

## HTTPS

Pulse doesn't terminate TLS. Put a reverse proxy in front — Caddy, Nginx, or Traefik all work. The [Self-Hosted Guide](README-SELFHOSTED-SUPABASE.md#set-up-https) has example configs for Caddy and Nginx.

## Architecture

Subsystem deep-dives for contributors live in [docs/](docs/):
[federation wire protocol](docs/federation.md) ·
[E2EE sender keys](docs/e2ee-sender-keys.md) ·
[voice lifecycle](docs/voice.md) ·
[desktop integration](docs/desktop-integration.md)

The notes for the current release live at the repository root: [RELEASE-NOTES-v0.4.0.md](RELEASE-NOTES-v0.4.0.md). Contributor setup, the test loop and the pre-push gate are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Built with

[Bun](https://bun.sh) · [React](https://react.dev) · [tRPC](https://trpc.io) · [Drizzle ORM](https://orm.drizzle.team) · [Mediasoup](https://mediasoup.org) · [Tailwind CSS](https://tailwindcss.com) · [Signal Protocol](https://signal.org/docs/) · optional [Supabase](https://supabase.com)

## License

[AGPL-3.0](LICENSE)
