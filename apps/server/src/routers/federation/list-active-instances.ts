import { listActiveFederationInstances } from '../../db/queries/federation';
import { protectedProcedure } from '../../utils/trpc';

// User-facing federation discovery. Returns only `active` peers and
// only the fields the client needs to render the discover view.
// Pending/blocked rows and direction (incoming/outgoing/mutual) are
// operator metadata and stay behind `listInstances`'s admin gate.
const listActiveInstancesRoute = protectedProcedure.query(async () => {
  const instances = await listActiveFederationInstances();
  return instances.map((i) => ({
    id: i.id,
    domain: i.domain,
    name: i.name,
    lastSeenAt: i.lastSeenAt
  }));
});

export { listActiveInstancesRoute };
