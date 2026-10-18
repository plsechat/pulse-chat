# Pulse Chat v0.4.1

Released: 2026-10-18

## Fixes

- Existing accounts get the tab layout. An appearance preference saved before v0.4.0 had no layout key, and neither the client preference store, the step that applies the server's copy, nor the server's preferences read filled in the default, so those accounts stayed on the traditional layout until they toggled the setting once. Every preference section is now laid over its defaults wherever it is read, which also covers any key added in a future release.

## Release workflow

- The Manual Release workflow refuses to start without an explicit version bump, and refuses a no-bump run on a version whose tag already exists (that path rebuilt and overwrote the previous release's image and assets). Rebuilding an existing version is still possible by dispatching on its tag.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

No schema changes.
