import { listFederationInstances } from '../../db/queries/federation';
import { protectedProcedure } from '../../utils/trpc';

const listInstancesRoute = protectedProcedure.query(async () => {
  const instances = await listFederationInstances();

  return instances.map((i) => ({
    id: i.id,
    domain: i.domain,
    name: i.name,
    status: i.status as 'pending' | 'active' | 'blocked',
    direction: i.direction as 'outgoing' | 'incoming' | 'mutual',
    lastSeenAt: i.lastSeenAt,
    createdAt: i.createdAt
  }));
});

export { listInstancesRoute };
