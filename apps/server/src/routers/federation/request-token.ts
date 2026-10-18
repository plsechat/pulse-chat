import z from 'zod';
import { config } from '../../config';
import { getActiveFederationInstanceByDomain } from '../../db/queries/federation';
import { logger } from '../../logger';
import { generateFederationToken } from '../../utils/federation';
import { protectedProcedure } from '../../utils/trpc';

const requestTokenRoute = protectedProcedure
  .input(
    z.object({
      targetDomain: z.string().min(1).max(253)
    })
  )
  .mutation(async ({ ctx, input }) => {
    try {
      logger.info('[federation/requestToken] called by userId=%d, targetDomain=%s', ctx.userId, input.targetDomain);

      if (!config.federation.enabled) {
        logger.warn('[federation/requestToken] federation not enabled');
        ctx.throwValidationError('federation', 'Federation is not enabled');
      }

      const instance = await getActiveFederationInstanceByDomain(
        input.targetDomain
      );
      logger.info('[federation/requestToken] instance=%o', instance ? { id: instance.id, domain: instance.domain, status: instance.status } : null);

      if (!instance) {
        logger.warn('[federation/requestToken] instance not found or not active');
        ctx.throwValidationError(
          'targetDomain',
          'Not a trusted federated instance'
        );
      }

      logger.info('[federation/requestToken] generating token...');
      const token = await generateFederationToken(
        ctx.userId,
        ctx.user.name,
        input.targetDomain,
        undefined,
        ctx.user.publicId
      );

      const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h
      logger.info('[federation/requestToken] token generated, expiresAt=%d', expiresAt);

      return { token, expiresAt };
    } catch (error) {
      logger.error('[federation/requestToken] error: %o', error);
      throw error;
    }
  });

export { requestTokenRoute };
