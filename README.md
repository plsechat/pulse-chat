<div align="center">
  <img src="https://raw.githubusercontent.com/plsechat/pulse-chat/main/apps/client/public/logo.png" alt="Pulse Chat" width="80" />
  <h1>Pulse Chat</h1>
  <p>Self-hosted communication platform with E2EE, voice/video, and federation.</p>

  [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
  [![Last Commit](https://img.shields.io/github/last-commit/plsechat/pulse-chat)](https://github.com/plsechat/pulse-chat/commits)

  <!-- TODO: Add a screenshot here -->
  <!-- <img src="docs/screenshot.png" alt="Screenshot" width="700" /> -->
</div>

---

## Features

- **End-to-end encryption** — Signal Protocol (X3DH + Double Ratchet) for DMs and channels
- **Voice, video & screen sharing** — WebRTC via Mediasoup
- **Federation** — Connect multiple Pulse instances together
- **Forum channels** — Threaded discussions with tags
- **Text channels & DMs** — Real-time messaging with file sharing, reactions, and threads
- **Custom roles & permissions** — Granular access control at server, channel, and user level
- **Custom emojis** — Upload and manage server emojis
- **Automod** — Keyword, regex, mention limit, and link filtering rules
- **Webhooks** — Integrate with external services
- **OAuth** — Google, Discord, Facebook, Twitch (configurable)
- **Invite-only mode** — Disable open registration per instance

> [!NOTE]
> Pulse Chat is in alpha (v0.1.3). Expect bugs and breaking changes between updates.

## Quick Start

Pulse requires a Supabase instance for authentication and database. You can use [Supabase Cloud](https://supabase.com) or self-host it. See the [Self-Hosted Supabase Guide](README-SELFHOSTED-SUPABASE.md) for the full Docker Compose setup including PostgreSQL, GoTrue, and Kong.

### Docker (Recommended)

```bash
docker run \
  -p 4991:4991/tcp \
  -p 40000-40020:40000-40020/tcp \
  -p 40000-40020:40000-40020/udp \
  -v ./data:/root/.config/pulse \
  --name pulse \
  ghcr.io/plsechat/pulse-chat:latest
```

For production deployments with Supabase included, use the [docker-compose-supabase.yml](docker-compose-supabase.yml) setup described in the [Self-Hosted Guide](README-SELFHOSTED-SUPABASE.md).

### Linux Binary

Download the latest Linux x64 binary from [Releases](https://github.com/plsechat/pulse-chat/releases).

```bash
curl -L https://github.com/plsechat/pulse-chat/releases/latest/download/pulse-linux-x64 -o pulse
chmod +x pulse
./pulse
```

### First Launch

1. Open `http://localhost:4991` in your browser
2. A **security token** will be printed to the server console on first run — save it securely
3. Create an account and log in
4. To claim owner permissions: open browser DevTools console and run `useToken('your_token_here')`

## Configuration

A default config is generated at `~/.config/pulse/config.ini` on first run.

| Section | Field | Default | Description |
|---------|-------|---------|-------------|
| server | `port` | `4991` | HTTP and WebSocket port |
| server | `debug` | `false` | Enable debug logging |
| server | `autoupdate` | `false` | Auto-check and install updates |
| http | `maxFiles` | `40` | Max files per upload request |
| http | `maxFileSize` | `100` | Max file size in MB |
| mediasoup | `worker.rtcMinPort` | `40000` | WebRTC UDP min port |
| mediasoup | `worker.rtcMaxPort` | `40020` | WebRTC UDP max port |
| mediasoup | `video.initialAvailableOutgoingBitrate` | `6000000` | Voice/video bandwidth (bps) |
| federation | `enabled` | `false` | Enable federation |
| federation | `domain` | | Your instance's public domain (required when federation is enabled) |

> [!IMPORTANT]
> The `rtcMinPort`–`rtcMaxPort` range determines how many concurrent voice/video connections your server can handle. Each connection uses one UDP port. These ports must be open in your firewall (TCP and UDP). If using Docker, map this range from host to container.

## HTTPS

Pulse does not handle TLS directly. Use a reverse proxy (Nginx, Caddy, or Traefik) to terminate HTTPS. See the [Self-Hosted Guide](README-SELFHOSTED-SUPABASE.md) for example configurations.

## Tech Stack

[Bun](https://bun.sh) · [tRPC](https://trpc.io) · [Mediasoup](https://mediasoup.org) · [Drizzle ORM](https://orm.drizzle.team) · [React](https://react.dev) · [Tailwind CSS](https://tailwindcss.com) · [Supabase](https://supabase.com) · [Signal Protocol](https://signal.org/docs/)

## License

[AGPL-3.0](LICENSE)
