# Pulse E2E suite

Playwright tests that drive the real client against real dockerized
Pulse instances — the layer the unit suite can't see: cold-boot paths,
client↔server wiring, browser focus/hover semantics, and two-instance
federation. Born from the 2026-07-14 live-testing session that found
four shipped bugs the unit suite missed.

## Layout

| Project      | Instance(s)                    | Covers |
|--------------|--------------------------------|--------|
| `core`       | `127.0.0.1:14991`              | auth, messaging (incl. reaction-picker regression), voice-has-no-chat, file/DM-token security |
| `sso`        | `127.0.0.1:14993`              | derived SSO-only login mode: UI rendering + `/login`/`/register` gates |
| `federation` | `127.0.0.1:14994` + `:14995`   | full peering → discover → join → cross-instance messaging → DM |
| `probes`     | `127.0.0.1:14991`              | env-gated probe utilities (`tests/probes/*-probe.spec.ts`, `ui-baseline.spec.ts`): screenshot walkers and manual-review harnesses for cosmetics, nameplates, emoji, previews, mic, OBS, reports. Not a CI gate. |

Instances are defined in `docker/compose.yml` (no volumes — every
`up` is a first boot; `down` fully resets). Instance config
(federation domain etc.) is injected via env by `docker/entrypoint.sh`
**before** first boot — no config-file editing after the fact.

## Run locally

```bash
cd e2e
npm install
npx playwright install chromium

npm run env:up        # build + start all instances (first build ~5 min)
npm test              # all projects
npm run test:core     # one project
npm run env:down      # stop + wipe
```

Probes are opt-in: every spec in `tests/probes/` calls
`test.skip(!process.env.<NAME>_PROBE, ...)` (or `UI_SHOTS`) at the top,
so `npm test` lists them as skipped and `--project=core` never sees
them. Run one by setting its variable:

```bash
COSMETICS_PROBE=1 npx playwright test --project=probes
```

The `probes` project shares the `core` instance, the `core-setup`
dependency and the fake-media launch flags; it exists so that
exploratory specs never dilute the gating `core` run.

`npm run env:down && npm run env:up` between full runs gives every run
a pristine first-boot state. Re-running against a live environment also
works — setup falls back to login when accounts already exist — but
message-count style assertions are written to tolerate it.

## Conventions

- **Auth via API + storageState** — `tests/core/core.setup.ts` registers
  the shared accounts over HTTP and stores their localStorage tokens;
  tests boot straight into the app. UI login is only exercised in
  `auth.spec.ts` itself.
- **Selectors** live in `helpers/ui.ts`; specs use role/text locators.
- **Shared accounts and users** come from `helpers/fixtures.ts`:
  `CORE_OWNER` (first registration → instance operator) and
  `CORE_USER_B` (joined non-owner member) are the two stable accounts;
  `runUser(prefix)` mints a per-run unique throwaway user (`RUN_TAG`
  suffix — display names are unique per instance, so reruns against a
  live env would otherwise collide); `registerAndJoin(browser, baseURL,
  user)` registers over HTTP and drives one Discover → Join pass;
  `authedPage(browser, baseURL, user)` gives a fresh authenticated
  context (refresh tokens are one-time-use, so a storageState cannot be
  shared between contexts — log in per context).
- **Other helpers**: `helpers/api.ts` (`registerUser`, `loginUser`,
  `storageStateFor`, `fetchInfo`, raw `apiRequest`), `helpers/db.ts`
  (`psql(instance, sql)` runs SQL inside an instance's Postgres
  container for assertions the UI cannot make).
- **Binary fixtures** in `fixtures/`: `pixel.png` (1×1 upload smoke),
  `plate-test.png` and `pulse-nameplate-drowned.gif` (nameplate / plate
  uploads used by the probes).
- **Known bugs are `test.fixme`** entries next to the flow that found
  them — they document the repro and flip to real tests when fixed.
- **workers: 1 per project** — each project shares one live instance;
  projects target different instances.
- The federation project resolves `pulse-fed-b:4991` (the peer's
  Instance Domain, used verbatim by the client) to `127.0.0.1:14995`
  via a Chromium host-resolver rule — same URLs as production, no
  app-side special-casing.

## CI

`.github/workflows/e2e.yml` runs the full suite on every push to
dev/main and on PRs, building the harness image with a GHA-cached
buildx layer cache. On failure it uploads the Playwright report +
traces and dumps instance logs.
