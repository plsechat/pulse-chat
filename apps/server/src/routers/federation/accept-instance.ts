import { Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../../db';
import { getFirstServer } from '../../db/queries/servers';
import { federationInstances } from '../../db/schema';
import { config } from '../../config';
import { protectedProcedure } from '../../utils/trpc';
import { signChallenge } from '../../utils/federation';
import { pubsub } from '../../utils/pubsub';
import { invalidateCorsCache } from '../../http/cors';
import { logger } from '../../logger';

const acceptInstanceRoute = protectedProcedure
  .input(
    z.object({
      instanceId: z.number()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const server = await getFirstServer();
    await ctx.needsPermission(Permission.MANAGE_SETTINGS, server?.id);

    const [instance] = await db
      .select()
      .from(federationInstances)
      .where(eq(federationInstances.id, input.instanceId))
      .limit(1);

    if (!instance) {
      ctx.throwValidationError('instanceId', 'Instance not found');
    }

    if (instance!.status === 'blocked') {
      ctx.throwValidationError('instanceId', 'Instance is blocked');
    }

    // Update local record to active + mutual
    await db
      .update(federationInstances)
      .set({
        status: 'active',
        direction: 'mutual',
        updatedAt: Date.now()
      })
      .where(eq(federationInstances.id, input.instanceId));

    // Notify remote instance (retry once on failure, fire-and-forget)
    const notifyRemote = async (attempt: number) => {
      try {
        const signature = await signChallenge(config.federation.domain);
        const protocol = instance!.domain.includes('localhost') ? 'http' : 'https';

        const res = await fetch(`${protocol}://${instance!.domain}/federation/accept`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            domain: config.federation.domain,
            signature
          })
        });

        if (!res.ok && attempt < 2) {
          logger.warn('Remote instance returned %d on acceptance notification (attempt %d)', res.status, attempt);
          await Bun.sleep(2000);
          return notifyRemote(attempt + 1);
        }
      } catch (error) {
        logger.error('Failed to notify remote instance of acceptance (attempt %d):', attempt, error);
        if (attempt < 2) {
          await Bun.sleep(2000);
          return notifyRemote(attempt + 1);
        }
      }
    };
    notifyRemote(1).catch(() => {});

    invalidateCorsCache();

    pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
      domain: instance!.domain,
      status: 'active'
    });

    return { success: true };
  });

export { acceptInstanceRoute };
