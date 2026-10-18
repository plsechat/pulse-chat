# Desktop integration — the `window.pulseDesktop` contract

The desktop app is a separate repository
([plsechat/pulse-desktop](https://github.com/plsechat/pulse-desktop)): an
Electron shell that loads the web client over HTTP. The only coupling
between the two is a runtime global the shell's preload exposes and the
web client consumes, `window.pulseDesktop`. Its TypeScript shape lives in
`apps/client/src/vite-env.d.ts`; every member added after 0.0.x is
optional there so an older shell stays type-correct and the client
feature-detects (`typeof window.pulseDesktop?.x === 'function'`) rather
than reading a version. This page states what each member means. Keep
both repositories in sync when the shape changes.

Nothing on this surface is reachable from a server, a plugin or another
user: the shell calls the page and the page calls the shell, both inside
the one renderer process.

## Identity and settings

| Member | Meaning |
| --- | --- |
| `isElectron: true` | Present only inside the shell; the browser build has no `window.pulseDesktop` at all. Gate on the capability you need, not on this flag, wherever a finer member exists. |
| `platform: string` | Node's `process.platform` (`darwin`, `win32`, `linux`). |
| `connectToServer(url)` → `{ success, name?, version?, error? }` | Point the shell at a Pulse instance (it fetches `GET /info` and loads the client from there). |
| `disconnectServer()` | Back to the server selector. |
| `getSettings()` / `updateSetting(key, value)` | The shell's own persisted settings (tray, startup …). |
| `setBadgeCount?(count)` | Dock / taskbar badge (0 clears). Added in 0.1.0. |
| `getStartupEnabled?()` / `setStartupEnabled?(enabled)` | Launch at login. Added in 0.1.0. |
| `getWindowChrome?()` → `'overlay' \| 'native'`; `setTitleBarOverlay?({ color?, symbolColor? })` | Frameless-window chrome colours (Windows overlay). Added in 0.2.0. |

## Audio

| Member | Meaning |
| --- | --- |
| `audioDriver.getStatus()` / `install()` / `uninstall()` | The macOS virtual audio device used for system-audio screen share. |
| `audioCapture.isAvailable()` / `start()` / `stop()` | Routing system audio into a share; `start()` resolves the device the client should capture from. |

## Game presence — `onGamePresence` (added in 0.3.0)

```ts
onGamePresence(
  callback: (presence: { name: string } | null) => void
): () => void;
```

The shell detects the game the user is running (its own concern: a
curated list of executables, polled on the shell's schedule — none of
that lives in this repository) and reports it through the callback:

- **Shape.** `{ name }` while a known game runs, `null` when none does.
  `name` is the display title from the shell's list (the client trims it
  and the server caps it at 64 characters; longer titles are cut, not
  refused). No other fields: the start time is the server's, taken when
  it first stores a given title, so a reconnect never restarts "for N
  min".
- **Timing.** The shell invokes the callback **once immediately on
  subscribe** with the current state, then on **every change** — and
  only on changes; a periodic re-send of the same state is harmless but
  unnecessary. The client coalesces reports to the server's budget (one
  per 10 s per user), so the shell may report as often as it likes.
- **Unsubscribe.** The returned function stops the callbacks. The client
  subscribes only while the account preference *Share what you're
  playing* (User Settings → Privacy) is on, and unsubscribes — reporting
  nothing — when it goes off or the session ends. A shell must therefore
  not assume a subscriber exists: it keeps detecting (or not) on its
  own; the page is the only consumer.
- **Older shells.** A shell without `onGamePresence` simply has no game
  presence; the page detects the missing member and does nothing.

What the page does with a report (for the shell author's understanding;
none of it is the shell's job):

1. `users.setGamePresence({ name } | null)` goes to the user's **home**
   instance (never the federated instance being browsed). The server
   stores it only while the preference is on, bounded and rate-limited.
2. Every community the user is in receives it as a per-server
   `USER_UPDATE`, **except** the ones ticked under *Keep it private in
   these communities* (home servers by id, federated servers by
   `domain:publicId`); federated peers receive the same decision through
   the presence relay and apply it to their own rosters.
3. Rosters show "Playing <name>" under the member (it takes the place of
   the custom status while set), the profile card adds "for N min", the
   members pane groups players under **Now playing**, and the Home
   greeting shows the user's own game.
4. The presence is cleared when the user's last socket closes (sign-out,
   a closed app, a crash — after a short debounce a reconnect cancels) and
   by a server cron once it is older than 6 hours, so a crashed shell
   never leaves a ghost. The page re-reports the current game when its
   home session reopens.

### Fake shell for local testing

The browser build has no shell; to exercise the surfaces without the
desktop app, define the member before the client subscribes (sharing
on in Privacy, then reload with this in the console once):

```js
window.pulseDesktop = {
  isElectron: true, platform: 'darwin',
  onGamePresence(cb) { cb({ name: 'Rocket Pass' }); window.__endGame = () => cb(null); return () => {}; },
  // the rest of the surface is optional for this purpose
};
```

`apps/client/src/lib/__tests__/game-presence.test.ts` drives the same
callback through a fake `window.pulseDesktop` and is the executable form
of this contract.
