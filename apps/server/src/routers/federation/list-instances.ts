import { listFederationInstances } from '../../db/queries/federation';
import { protectedProcedure } from '../../utils/trpc';
import { assertInstanceOwner } from './guard';

const listInstancesRoute = protectedProcedure.query(async ({ ctx }) => {
  // Federation peer membership is operator-sensitive: revealing which
  // peers we federate with (and their pending/blocked state) is the
  // kind of metadata an attacker uses to map federation topology.
  // Only the instance owner may read it.
  await assertInstanceOwner(ctx.userId);

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
