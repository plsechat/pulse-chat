import type { TRemoteServerSummary } from '@pulse/shared';
import z from 'zod';
import { protectedProcedure } from '../../utils/trpc';
import { config } from '../../config';
import { getFederationInstanceById } from '../../db/queries/federation';
import { logger } from '../../logger';

const discoverRemoteRoute = protectedProcedure
  .input(
    z.object({
      instanceId: z.number()
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

    const protocol = instance!.domain.includes('localhost') ? 'http' : 'https';

    try {
      const res = await fetch(
        `${protocol}://${instance!.domain}/federation/servers?requesterDomain=${encodeURIComponent(config.federation.domain)}`
      );

      if (!res.ok) {
        return { servers: [] };
      }

      const data = (await res.json()) as {
        servers: Array<{
          publicId: string;
          name: string;
          description: string | null;
          logo: unknown;
          memberCount: number;
          hasPassword?: boolean;
        }>;
      };

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
    } catch (error) {
      logger.error('Failed to discover remote servers:', error);
      return { servers: [] };
    }
  });

export { discoverRemoteRoute };
