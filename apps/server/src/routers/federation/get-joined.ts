import { db } from '../../db';
import { federationInstances, userFederatedServers } from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import { protectedProcedure } from '../../utils/trpc';
import { getFederationProtocol } from '../../utils/validate-url';

const getJoinedRoute = protectedProcedure.query(async ({ ctx }) => {
  const rows = await db
    .select({
      instanceDomain: federationInstances.domain,
      instanceName: federationInstances.name,
      remoteServerId: userFederatedServers.remoteServerId,
      remoteServerPublicId: userFederatedServers.remoteServerPublicId,
      remoteServerName: userFederatedServers.remoteServerName
    })
    .from(userFederatedServers)
    .innerJoin(
      federationInstances,
      eq(userFederatedServers.instanceId, federationInstances.id)
    )
    .where(
      and(
        eq(userFederatedServers.userId, ctx.userId),
        eq(federationInstances.status, 'active')
      )
    );

  // Include the ready-to-dial base URL. Protocol selection (http for
  // LAN/private peers via FEDERATION_ALLOW_PRIVATE_CIDRS, https
  // otherwise) is server knowledge — the client must not guess it.
  // joinRemote returns remoteUrl the same way; without it here, the
  // client's reconnect path for previously joined servers rebuilt the
  // URL with a naive localhost-check and dialed wss:// against
  // plain-http peers.
  return rows.map((row) => ({
    ...row,
    remoteUrl: `${getFederationProtocol(row.instanceDomain)}://${row.instanceDomain}`
  }));
});

export { getJoinedRoute };
