<p align="center">
  <img src="https://raw.githubusercontent.com/plsechat/pulse-chat/main/apps/client/public/logo.png" alt="Pulse Chat" width="100" />
</p>

<h1 align="center">Pulse Chat</h1>

<p align="center">
  A self-hosted chat platform built for privacy, voice, and connecting communities.
  <br />
  <a href="https://plse.chat"><strong>plse.chat</strong></a> &middot;
  <a href="README-SELFHOSTED-SUPABASE.md">Self-Hosting Guide</a> &middot;
  <a href="https://github.com/plsechat/pulse-chat/releases">Releases</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License" /></a>
  <a href="https://github.com/plsechat/pulse-chat/commits"><img src="https://img.shields.io/github/last-commit/plsechat/pulse-chat" alt="Last Commit" /></a>
</p>

<!-- <p align="center"><img src="docs/screenshot.png" alt="Screenshot" width="720" /></p> -->

---

> [!NOTE]
> Pulse Chat is in alpha (v0.2.0). Expect bugs and breaking changes between updates.

> [!WARNING]
> **v0.2.0 introduces a breaking change to the federation wire format.** Outbound signed requests now embed the request body's SHA-256 in a `sha256` JWT claim, plus `iss`/`aud`/`jti` claims for replay and cross-instance protection. A v0.2 server **cannot** federate with a pre-v0.2 peer until both sides upgrade. Coordinate with peers before upgrading.

## Why Pulse?

Pulse is a self-hosted alternative to Discord and Slack that puts you in control. Every message can be end-to-end encrypted, voice and video stay on your infrastructure, and federation lets separate instances talk to each other — no central service required.

## What's included

| | |
|---|---|
| **Encrypted messaging** | Signal Protocol (X3DH + Double Ratchet) for DMs and channels |
| **Voice & video** | WebRTC-powered calls with screen sharing via Mediasoup |
| **Federation** | Link multiple Pulse instances so users can discover and join across servers |
| **Forum channels** | Threaded discussions with tags for long-form topics |
| **Channels & DMs** | Real-time text with file uploads, reactions, threads, and mentions |
| **Roles & permissions** | Granular access control at the server, channel, and user level |
| **Custom emojis** | Upload and manage emojis per server |
| **Automod** | Keyword filters, regex rules, mention limits, and link blocking |
| **Webhooks** | Push events to external services |
| **OAuth login** | Google, Discord, Facebook, Twitch — toggle each on or off |
| **Invite-only mode** | Lock down registration so only invited users can join |

## Getting started

Pulse runs against either of two auth backends — pick whichever fits:

| Backend | Needs | When to use |
|---|---|---|
| **`local`** (default) | Just PostgreSQL + an `AUTH_SECRET` | Single-node deployments, homelabs, anything where you don't want a SaaS dep. **Email + password only — no OAuth.** |
| **`supabase`** | Supabase Cloud or a self-hosted Supabase stack | OAuth providers (Google / Discord / etc), multi-instance setups that already run Supabase, federated networks where peers expect Supabase JWTs |

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

Pulse listens on `4991`; the bundled `postgres:16-alpine` is on `5432`. Open `http://localhost:4991` and the first user to register becomes the operator.

### Docker (existing Postgres / Supabase)

```bash
docker run \
  -p 4991:4991/tcp \
  -p 40000-40020:40000-40020/tcp \
  -p 40000-40020:40000-40020/udp \
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

### After first launch

1. Open `http://localhost:4991`
2. A **security token** prints to the server console on first run — save it
3. Register and log in
4. Claim ownership: open the browser console and run `useToken('your_token_here')`

## Configuration

### Environment

| Variable | Required when | What it does |
|---|---|---|
| `AUTH_BACKEND` | always (defaults inferred) | `local` or `supabase`. Defaults to `supabase` if `SUPABASE_URL` is set, else `local`. |
| `AUTH_SECRET` | `AUTH_BACKEND=local` | ≥32 random chars; HS256 signing key for session tokens. **Rotating invalidates every session.** |
| `DATABASE_URL` | always | Full Postgres connection string |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | `AUTH_BACKEND=supabase` | Managed or self-hosted Supabase Auth |
| `PUBLIC_IP` | production behind NAT | Public IP for WebRTC ICE candidates |
| `REGISTRATION_DISABLED` | optional | Lock down registration instance-wide |
| `DEBUG_LOGGING` | optional | Write JSON debug events to `log/debug.log` |

See [.env.example](.env.example) for the full list with comments.

### config.ini

A config file is generated at `~/.config/pulse/config.ini` on first run.

| Section | Key | Default | What it does |
|---|---|---|---|
| server | `port` | `4991` | HTTP / WebSocket port |
| server | `debug` | `false` | Verbose logging |
| server | `autoupdate` | `false` | Auto-check for updates |
| http | `maxFiles` | `40` | Max files per upload |
| http | `maxFileSize` | `100` | Max file size (MB) |
| mediasoup | `worker.rtcMinPort` | `40000` | WebRTC port range start |
| mediasoup | `worker.rtcMaxPort` | `40020` | WebRTC port range end |
| mediasoup | `video.initialAvailableOutgoingBitrate` | `6000000` | Bandwidth per stream (bps) |
| federation | `enabled` | `false` | Turn on federation |
| federation | `domain` | — | Your public domain (required for federation) |

> [!IMPORTANT]
> The port range `rtcMinPort`–`rtcMaxPort` controls how many concurrent voice/video connections are possible. Each connection uses one UDP port. Open these ports (TCP + UDP) in your firewall, and map the range in Docker if applicable.

## HTTPS

Pulse doesn't terminate TLS. Put a reverse proxy in front — Caddy, Nginx, or Traefik all work. The [Self-Hosted Guide](README-SELFHOSTED-SUPABASE.md#set-up-https) has example configs for Caddy and Nginx.

## Built with

[Bun](https://bun.sh) · [React](https://react.dev) · [tRPC](https://trpc.io) · [Drizzle ORM](https://orm.drizzle.team) · [Mediasoup](https://mediasoup.org) · [Tailwind CSS](https://tailwindcss.com) · [Signal Protocol](https://signal.org/docs/) · optional [Supabase](https://supabase.com)

## License

[AGPL-3.0](LICENSE)
