import type { TRemoteServerSummary } from '@pulse/shared';
import z from 'zod';
import { protectedProcedure } from '../../utils/trpc';
import { config } from '../../config';
import { getFederationInstanceById } from '../../db/queries/federation';
import { queryInstance } from '../../utils/federation';
import { logger } from '../../logger';

type TRemoteServersResponse = {
  servers?: Array<{
    publicId: string;
    name: string;
    description: string | null;
    logo: unknown;
    memberCount: number;
    hasPassword?: boolean;
  }>;
};

const discoverRemoteRoute = protectedProcedure
  .input(
    z.object({
      instanceId: z.number().int().positive()
    })
  )
  .query(async ({ ctx, input }) => {
    if (!config.federation.enabled) {
      ctx.throwValidationError('federation', 'Federation is not enabled');
    }

    const instance = await getFederationInstanceById(input.instanceId);

    if (!instance || instance.status !== 'active') {
      ctx.throwValidationError(
        'instanceId',
        'Instance not found or not active'
      );
    }

    // Signed request, signed response: the peer only lists its
    // federatable servers to a peer it has pinned, and we only trust a
    // list the peer signed for us.
    const data = await queryInstance<TRemoteServersResponse>(
      instance!.domain,
      '/federation/servers',
      {}
    );

    if (!data || !Array.isArray(data.servers)) {
      logger.warn(
        '[federation/discoverRemote] no server list from %s',
        instance!.domain
      );
      return { servers: [] };
    }

    const servers: TRemoteServerSummary[] = data.servers.map((s) => ({
      publicId: s.publicId,
      name: s.name,
      description: s.description,
      logo: s.logo as TRemoteServerSummary['logo'],
      memberCount: s.memberCount,
      instanceDomain: instance!.domain,
      instanceName: instance!.name || instance!.domain,
      hasPassword: s.hasPassword ?? false
    }));

    return { servers };
  });

export { discoverRemoteRoute };
