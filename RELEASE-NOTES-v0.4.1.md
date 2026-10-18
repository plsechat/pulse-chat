# Pulse Chat v0.4.1

Released: 2026-10-18

## Fixes

- Existing accounts get the tab layout. An appearance preference saved before v0.4.0 had no layout key, and neither the client preference store, the step that applies the server's copy, nor the server's preferences read filled in the default, so those accounts stayed on the traditional layout until they toggled the setting once. Every preference section is now laid over its defaults wherever it is read, which also covers any key added in a future release.

- A slash command the plugin refuses at once (for example `/watch pause` with nothing playing) could stay on "Running" for everyone until a reload: its failed state was published before the pending row had reached the viewers, who drop an update for a message they do not have yet. The command now runs only after the row's create has gone out.
- Reaction pills keep a stable order; two reactions added in the same millisecond could swap places between loads.

## Release workflow

- The Manual Release workflow refuses to start without an explicit version bump, and refuses a no-bump run on a version whose tag already exists (that path rebuilt and overwrote the previous release's image and assets). Rebuilding an existing version is still possible by dispatching on its tag.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

No schema changes.
