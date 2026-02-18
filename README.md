<div align="center">
  <h1>Pulse Chat</h1>
  <p><strong>A lightweight, self-hosted real-time communication platform</strong></p>

  [![Last Commit](https://img.shields.io/github/last-commit/plsechat/pulse-chat)](https://github.com/plsechat/pulse-chat/commits)

  [![Bun](https://img.shields.io/badge/Bun-v1.3.5-green.svg)](https://bun.sh)
  [![Mediasoup](https://img.shields.io/badge/Mediasoup-v3.19.11-green.svg)](https://mediasoup.org)
</div>

## What is Pulse Chat?

> [!NOTE]
> This requires a supabase deployed as currently that is what is handling the Database and Authentication routes. You can self host this or cloud. (I'd recommend self hosting it as the cloud is a slug.
> This project is in alpha stage. Bugs, incomplete features and breaking changes are to be expected.

Pulse Chat is a self-hosted communication platform that brings real-time voice channels, text chat, and file sharing to your own infrastructure—no third-party dependencies, complete data ownership, and full control over your group's communication.

## Getting Started

Pulse Chat is distributed as a standalone binary that bundles both server and client components. Get started by downloading the latest release for your platform from the [Releases](https://github.com/plsechat/pulse-chat/releases) page. We ship binaries for Windows, macOS, and Linux.

#### Linux x64

```bash
curl -L https://github.com/plsechat/pulse-chat/releases/latest/download/pulse-linux-x64 -o pulse
chmod +x pulse
./pulse
```

#### Docker

Pulse Chat can also be run using Docker. Here's how to run it:

```bash
docker run \
  -p 4991:4991/tcp \
  -p 40000-40020:40000-40020/tcp \
  -p 40000-40020:40000-40020/udp \
  -v ./data:/root/.config/pulse \
  --name pulse \
  pulse:latest
```

#### Windows

1. Download the latest `pulse-windows-x64.exe` from the [Releases](https://github.com/plsechat/pulse-chat/releases/latest) page.
2. Open Command Prompt and navigate to the directory where you downloaded the executable.
3. Run the server with the command: `.\pulse-windows-x64.exe`

Make sure you download Microsoft Visual C++ 2015 - 2022 Redistributable (x64) from [here](https://aka.ms/vs/17/release/vc_redist.x64.exe) and install it before running on Windows.

### Open The Client

Once the server is running, open your web browser and navigate to [http://localhost:4991](http://localhost:4991) to access the client interface. If you're running the server on a different machine, replace `localhost` with the server's IP address or domain name.

> [!NOTE]
> Upon first launch, a secure token will be created and printed to the console. This token allows ANYONE to gain owner access to your server, so make sure to store it securely and do not lose it!

### Gain Owner Permissions

1. Login into your server
2. Open Dev Tools (`CTRL + Shift + I` or `Right Click > Inspect`)
3. Open the console
4. Type useToken('your_token_here')
5. Press enter
6. Your account will now have the owner role

The way of using this token will be more user friendly in the future.

## Configuration

Upon first run, a default configuration file will be generated at `~/.config/pulse/config.ini`. You can modify this file to customize your server settings.

### Options

| Field         | Default | Description                                                                                 |
| ------------- | ------- | ------------------------------------------------------------------------------------------- |
| `port`        | `4991`  | The port number on which the server will listen for HTTP and WebSocket connections          |
| `debug`       | `false` | Enable debug logging for detailed server logs and diagnostics                               |
| `maxFiles`    | `40`    | Maximum number of files that can be uploaded in a single request                            |
| `maxFileSize` | `100`   | Maximum file size in megabytes (MB) allowed per uploaded file                               |
| `rtcMinPort`  | `40000` | Minimum UDP port for WebRTC media traffic (voice/video)                                     |
| `rtcMaxPort`  | `40020` | Maximum UDP port for WebRTC media traffic (voice/video)                                     |
| `autoupdate`  | `false` | When enabled, it will automatically check for and install updates with no user intervention |
| `initialAvailableOutgoingBitrate` | `6000000` | Configure the Available bandwidth for Voice/Video RTC                 |

> [!IMPORTANT]
> `rtcMinPort` and `rtcMaxPort` will define how many concurrent voice/video connections your server can handle. Each active voice/video connection uses one UDP port. Make sure to adjust the range according to your expected load. These ports must be open in your firewall settings, both TCP and UDP. If you're running in Docker, remember to map this port range from the host to the container.

## HTTPS Setup

At the moment, there is no built-in support for HTTPS. To secure your server with HTTPS, we recommend using a reverse proxy like Nginx or Caddy. This setup allows you to manage SSL/TLS certificates and handle secure connections.

## Acknowledgments

Built with amazing open-source technologies:

- [Bun](https://bun.sh)
- [tRPC](https://trpc.io)
- [Mediasoup](https://mediasoup.org)
- [Drizzle ORM](https://orm.drizzle.team)
- [React](https://react.dev)
- [Radix UI](https://www.radix-ui.com)
- [ShadCN UI](https://ui.shadcn.com/)
- [Tailwind CSS](https://tailwindcss.com)
- [Supabase](https://supabase.com)
