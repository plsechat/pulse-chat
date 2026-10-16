# Contributing to Pulse

Thanks for contributing. This document explains how we work so your changes can land smoothly and nobody wastes time on work we can't merge.

## Quick rules (please read)

### 1) All PRs must target `dev`

`dev` is our trunk branch. Open all pull requests against `dev`. PRs targeting other branches will be closed or retargeted. Periodically, `dev` is merged into `main` for stable releases.

### 2) All PRs must include a short description

Every PR must include a short description covering:

- what changed
- why it changed
- anything reviewers should pay attention to

A few bullets is fine.

### 3) Open an issue before submitting a PR

We strongly prefer that every PR addresses an existing issue. If one doesn't exist yet, open one describing the problem or improvement and your proposed approach. This gives maintainers a chance to weigh in on direction before you invest time, and avoids the mutual displeasure of:

- you doing significant work, and
- us having to reject or postpone the change because it doesn't align with current goals, or because we aren't ready to maintain what it introduces

For small, obvious fixes (typos, broken links, trivial one-liners) you can skip the issue and go straight to a PR.

Ways to coordinate on larger work:

- open an issue describing the problem and your proposed approach
- open a draft PR early to confirm direction
- discuss with a maintainer in any channel you already share

If you're unsure whether something needs an issue first, it probably does.

### 4) Understand the code you submit

You must have sufficient understanding of every change in your PR to explain it and defend it during review. You don't need to write an essay, but you should be able to give a short summary of what the patch does and why it's correct.

**LLM-assisted contributions.** You're welcome to use LLMs as a tool for automating mechanical work. We don't ask you to disclose this, since we assume you're acting in good faith: you're the one who signs off on the patch you submit in your own name, and you have the technical understanding to verify that it's accurate.

That said, don't use LLMs on areas of the codebase you don't understand well enough to verify the output. If part of your change touches code you aren't confident reviewing yourself, say so in the issue you opened beforehand and defer that work to someone else. The maintainers will be happy to help.

## Project structure

Pulse is a monorepo managed with Bun workspaces:

- `apps/server/` — backend (Bun, tRPC, Drizzle ORM, PostgreSQL)
- `apps/client/` — frontend (React, Vite)
- `packages/shared/` — shared types and constants
- `packages/plugin-sdk/` — SDK for building server plugins

The desktop client (Electron wrapper + native audio) lives in a separate
repository: [plsechat/pulse-desktop](https://github.com/plsechat/pulse-desktop).
Browser end-to-end tests live in `e2e/` (see [e2e/README.md](e2e/README.md)).
Release notes for each version live at the repository root as
`RELEASE-NOTES-v<version>.md`.

## Workflow

1. Fork the repo (or create a branch if you have access).
2. Create a feature branch from `dev`.
3. Make changes.
4. Open a PR into `dev` with a short description.
5. Address review feedback and CI results.
6. We squash-merge approved PRs into `dev`.

We strongly prefer small, focused PRs that are easy to review.

### Commit style and history

We squash-merge PRs, so the PR title becomes the single commit message on `dev`. For that reason:

- PR titles must follow Conventional Commits.
- Individual commits inside the PR don't need to follow Conventional Commits.

If you like to commit in small increments, feel free. If you prefer a tidier PR history, force-pushes are welcome (for example, to squash or reorder commits before review). Just avoid rewriting history in a way that makes it hard for reviewers to follow along.

## Conventional Commits (required for PR titles)

Because the PR title becomes the squash commit message, we require Conventional Commits for PR titles.

We prefer type/subject to be mostly lowercase.

Format:

- `type(scope optional): short description`

Examples:

- `fix: handle empty response from api`
- `feat(auth): add passkey login`
- `docs: clarify dev workflow`
- `refactor: simplify retry logic`
- `chore(ci): speed up checks`

Breaking changes:

- `feat!: remove legacy auth endpoints`
- `refactor(api)!: change pagination shape`

Common types:
`feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`

## Tests (guidance)

We care about confidence more than ceremony. Add tests when they provide real value.

### Server tests

Server tests run with your host `bun` against a throwaway PostgreSQL in Docker. CI provides the database automatically; locally, start one — **never point `DATABASE_URL` at a real database**, the test preload truncates every table:

```bash
docker run -d --name pulse-test-pg -p 5433:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
  postgres:16-alpine

cd apps/server

# one file (fast iteration; ~2 s per file)
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres \
  bun test src/routers/__tests__/users.test.ts

# the whole suite, one process per file — this is what CI runs
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres \
  bash scripts/test-per-file.sh
```

The per-file script is the gate: it runs every `*.test.ts` in its own `bun test` process and fails on a non-zero exit **or** any `(fail)` line in the output, exactly like the CI shard. The per-test timeout is 15 s (`bunfig.toml`), so you don't need `--timeout` on the command line.

Rules that keep the suite deterministic:

- **Never call `mock.module()` in a test file.** Bun's module mocks are process-global and cannot be restored, so a mocked module leaks into every file that runs after it in the same process. Use `spyOn(...)` plus `afterEach(() => mock.restore())`, or swap `globalThis.fetch` and restore it. The only `mock.module` calls allowed are the four preload files in `src/__tests__/`.
- **Database setup goes inside each test, not in `beforeEach`.** The preload already truncates between tests; a `beforeEach` that inserts rows races that truncate and deadlocks.
- Backend changes that add or modify operational behaviour need a unit test; pure cosmetics don't.

### Client tests

The client has a small unit suite (E2EE key chains, safety numbers, store scoping). No database needed:

```bash
bun run --filter client test
```

### Browser end-to-end tests

Playwright specs in `e2e/` drive the real client against dockerized instances — see [e2e/README.md](e2e/README.md). The `probes` project there holds exploratory/visual probe specs that are not part of the CI gate.

### Before you push

`bun test` does not type-check. Run the full gate from the repo root — CI runs each of these as a separate job and all must be green:

```bash
bun run check-types   # tsc for every workspace
bun run lint          # eslint for every workspace
bun run knip          # unused files / exports / dependencies
```

`tsc` lives in each workspace's `node_modules/.bin`; there is no root `tsc`, so always go through the scripts above.

### Backend changes

For backend changes that add or modify operational features, add a unit test.

- Test files live alongside the code they test (e.g. `src/routers/__tests__/`)
- Authorization is declared, not hand-rolled: build tRPC routes on the procedure builders in `apps/server/src/utils/procedures.ts` and pick the one that matches the route's input — `serverProcedure(permission?)` when the route acts in the connection's active server (then filter every fetch-by-id by `ctx.activeServerId`), `channelProcedure(channelPermission?, { preview?, serverPermission? })` when the input names a `channelId` (the channel is loaded, scoped to the active server and handed over as `ctx.channel`), `serverProcedureFor(permission)` when the input names a `serverId` (the permission is evaluated in that server), and `instanceOwnerProcedure` for operator-only surfaces. A route built on a builder cannot forget its check; a bare `protectedProcedure` is for self-scoped routes only (own user, DM membership, friendship).
- Schema changes go through `cd apps/server && bun run db:gen`, then hand-patch the generated SQL to be idempotent (`IF NOT EXISTS` / `DO $$ … EXCEPTION` guards). CI applies every migration twice and fails if the second pass errors.
- If a unit test would require heavy mocking to be meaningful, restructure the code so it can be tested cleanly through its interfaces
- If you're unsure how to approach this, discuss it with a maintainer before investing time

### Frontend changes

We don't generally encourage new unit tests for frontend code unless:

- the area already has unit tests, or
- the change is complex or sensitive, and a unit test clearly reduces risk

Pure UI/cosmetic changes (CSS tweaks, layout adjustments) do not require unit tests. In most cases, clear PR notes and practical verification are more valuable.

## Formatting and linting

Don't block on formatting or linting before opening a PR. CI enforces required checks and will tell you what needs fixing before merge.

Open the PR when it's ready for review, then iterate based on CI and feedback.

## PR checklist

Before requesting review:

- [ ] PR targets `dev`
- [ ] PR title follows Conventional Commits (mostly lowercase)
- [ ] PR includes a short description of what/why
- [ ] You understand every change in the PR and can explain it during review
- [ ] Tests added or updated where it makes sense (especially backend changes)
- [ ] CI is green (or you're actively addressing failures)

Optional but helpful:

- screenshots or a short recording for UI changes
- manual verification steps

## Security

Please don't report security issues via public GitHub issues.

Instead, use GitHub's private vulnerability reporting:

- Go to the [Security tab](https://github.com/plsechat/pulse-chat/security) of the repository and select "Report a vulnerability"

## License

By contributing to Pulse, you agree that your contributions will be licensed under the [GNU Affero General Public License v3.0](./LICENSE).
