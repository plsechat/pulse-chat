# Pulse Chat v0.4.2

Released: TBD

Security and maintenance release. No feature changes.

## Runtime

- The server image moves from Bun 1.3.9 to Bun 1.4.4, which carries Bun's October 2026 security fixes for TLS, HTTP, WebSocket, Brotli and `fetch`. The image contains no Node.js binary, so the Node.js October 2026 security release (CVE-2026-111497 and related) does not apply to the shipped container; it does apply to the desktop app, which is updated separately.
- Bun 1.4 changes a few WebSocket details: a close without a code reports 1005, the close event waits for the closing handshake (30 seconds, then 1006), and `idleTimeout: 0` means never. The server's own sockets were checked against these and the test suites pass.

## Fixes surfaced by the upgrade

- Kick, ban, account deletion and session revocation closed the socket with codes 40000 to 40004, which are outside the WebSocket close-code range; Bun 1.4's `ws` refuses them, so a kick threw instead of disconnecting the member, and before that browsers only ever received a generic 1006. The codes are now 4100 to 4104, and the kicked and banned screens receive the real code. Plugins or clients that matched on the old numbers must update.
- The composer no longer reads a Tiptap editor instance that has been torn down (Tiptap 3.3 nulls its schema on destroy), which blanked the page when a conversation switched while the composer remounted.
- The slash-command palette reappears when you type on after closing it with Escape; the upgraded suggestion plugin would otherwise keep it hidden until the slash moved.
- A message-link jump from a DM into a community channel keeps its highlight: the session reload that follows the switch no longer clears it, and a jump within 2.5 seconds of another no longer loses its flash to the earlier jump's timer.

## Dependencies

- Every dependency advisory reported by `bun audit` is resolved except esbuild's development-server one, which only reaches the dev tooling through drizzle-kit and tsx. Notable: DOMPurify 3.3.1 to 3.4.17 (21 advisories), Tiptap and ProseMirror (ReDoS), `ws`, `zod`, systeminformation, lodash-es, happy-dom and the Vite chain. `protobufjs` (via libsignal) and `tar` (mediasoup's install step) are pinned past their critical advisories through overrides.
- drizzle-orm 0.44 to 0.45. No schema or migration changes result from it.
- mediasoup-client stays on the 3.18 line to match the server's mediasoup 3.19; the SFU pair is upgraded together in a later release.
- Playwright 1.64 for the end-to-end suite.

## Continuous integration

- The end-to-end jobs pin Node.js 22.23.4 (the patched release) instead of a floating 22.
- Every GitHub Action is on its current major (checkout v7, setup-node v7, upload-artifact v7, attest-build-provenance v4, the Docker actions v4/v7, gh-release v3, CodeQL v4), which moves the workflows off the deprecated Node 20 action runtime.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

No schema changes. Instances that run the server from source need Bun 1.4.4 or newer.
