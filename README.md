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
> Pulse Chat is in alpha (v0.1.3). Expect bugs and breaking changes between updates.

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

Pulse needs a Supabase backend (auth + database). You can use [Supabase Cloud](https://supabase.com) or self-host everything together — see the [Self-Hosted Guide](README-SELFHOSTED-SUPABASE.md) for the full Docker Compose setup with PostgreSQL, GoTrue, and Kong.

### Docker

```bash
docker run \
  -p 4991:4991/tcp \
  -p 40000-40020:40000-40020/tcp \
  -p 40000-40020:40000-40020/udp \
  -v ./data:/root/.config/pulse \
  --name pulse \
  ghcr.io/plsechat/pulse-chat:latest
```

For production with Supabase bundled, use [docker-compose-supabase.yml](docker-compose-supabase.yml) from the [Self-Hosted Guide](README-SELFHOSTED-SUPABASE.md).

### Linux binary

```bash
curl -L https://github.com/plsechat/pulse-chat/releases/latest/download/pulse-linux-x64 -o pulse
chmod +x pulse
./pulse
```

### After first launch

1. Open `http://localhost:4991`
2. A **security token** prints to the server console on first run — save it
3. Register and log in
4. Claim ownership: open the browser console and run `useToken('your_token_here')`

## Configuration

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

[Bun](https://bun.sh) · [React](https://react.dev) · [tRPC](https://trpc.io) · [Drizzle ORM](https://orm.drizzle.team) · [Mediasoup](https://mediasoup.org) · [Tailwind CSS](https://tailwindcss.com) · [Supabase](https://supabase.com) · [Signal Protocol](https://signal.org/docs/)

## License

[AGPL-3.0](LICENSE)
