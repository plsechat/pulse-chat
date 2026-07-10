import z from 'zod';
import { config } from '../../config';
import { getFederationInstanceById } from '../../db/queries/federation';
import { logger } from '../../logger';
import { generateFederationToken } from '../../utils/federation';
import { protectedProcedure } from '../../utils/trpc';
import { getFederationProtocol } from '../../utils/validate-url';

const joinRemoteRoute = protectedProcedure
  .input(
    z.object({
      instanceId: z.number(),
      remoteServerPublicId: z.string()
    })
  )
  .mutation(async ({ ctx, input }) => {
    try {
      logger.info('[federation/joinRemote] called by userId=%d, input=%o', ctx.userId, input);

      if (!config.federation.enabled) {
        logger.warn('[federation/joinRemote] federation not enabled');
        ctx.throwValidationError('federation', 'Federation is not enabled');
      }

      const instance = await getFederationInstanceById(input.instanceId);
      logger.info('[federation/joinRemote] instance=%o', instance ? { id: instance.id, domain: instance.domain, status: instance.status } : null);

      if (!instance || instance.status !== 'active') {
        logger.warn('[federation/joinRemote] instance not found or not active');
        ctx.throwValidationError(
          'instanceId',
          'Instance not found or not active'
        );
      }

      logger.info('[federation/joinRemote] generating federation token for domain=%s', instance!.domain);
      const token = await generateFederationToken(
        ctx.userId,
        ctx.user.name,
        instance!.domain,
        undefined,
        ctx.user.publicId
      );
      logger.info('[federation/joinRemote] token generated, length=%d', token.length);

      const protocol = getFederationProtocol(instance!.domain);
      const remoteUrl = `${protocol}://${instance!.domain}`;
      logger.info('[federation/joinRemote] returning remoteUrl=%s', remoteUrl);

      return {
        federationToken: token,
        remoteUrl,
        remoteServerPublicId: input.remoteServerPublicId
      };
    } catch (error) {
      logger.error('[federation/joinRemote] error: %o', error);
      throw error;
    }
  });

export { joinRemoteRoute };
