import { listActiveFederationInstances } from '../../db/queries/federation';
import { protectedProcedure } from '../../utils/trpc';

// User-facing federation discovery. Returns only `active` peers and
// only the fields the client needs to render the discover view and the
// server rail. Pending/blocked rows and direction (incoming/outgoing/
// mutual) are operator metadata and stay behind `listInstances`'s
// admin gate. `lastError` is included because the rail marks a
// federated server whose peer is degraded (an older peer lacking a
// route, an unreachable peer) — the user is the one whose messages
// are not arriving, so they get to see why.
const listActiveInstancesRoute = protectedProcedure.query(async () => {
  const instances = await listActiveFederationInstances();
  return instances.map((i) => ({
    id: i.id,
    domain: i.domain,
    name: i.name,
    lastSeenAt: i.lastSeenAt,
    peerVersion: i.peerVersion,
    lastError: i.lastError,
    lastErrorAt: i.lastErrorAt,
    pendingOutbox: i.pendingOutbox,
    deadOutbox: i.deadOutbox
  }));
});

export { listActiveInstancesRoute };
