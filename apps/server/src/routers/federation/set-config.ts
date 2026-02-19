import { Permission, ServerEvents } from '@pulse/shared';
import { stringify } from 'ini';
import fs from 'node:fs/promises';
import z from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { deleteShadowUsersByInstance } from '../../db/mutations/federation';
import { getFirstServer } from '../../db/queries/servers';
import { federationInstances, federationKeys } from '../../db/schema';
import { CONFIG_INI_PATH } from '../../helpers/paths';
import { invalidateCorsCache } from '../../http/cors';
import { logger } from '../../logger';
import {
  generateFederationKeys,
  getLocalKeys
} from '../../utils/federation';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const setConfigRoute = protectedProcedure
  .input(
    z.object({
      enabled: z.boolean(),
      domain: z.string().min(1)
    })
  )
  .mutation(async ({ ctx, input }) => {
    try {
      logger.info('[federation/setConfig] called by userId=%d, input=%o', ctx.userId, input);

      const server = await getFirstServer();
      logger.info('[federation/setConfig] firstServer id=%s, ownerId=%s', server?.id, server?.ownerId);

      await ctx.needsPermission(Permission.MANAGE_SETTINGS, server?.id);
      logger.info('[federation/setConfig] permission check passed');

      // Mutate config in memory
      logger.info('[federation/setConfig] config.federation before: %o', config.federation);
      config.federation.enabled = input.enabled;
      config.federation.domain = input.domain;
      logger.info('[federation/setConfig] config.federation after: %o', config.federation);

      // Persist to INI file
      logger.info('[federation/setConfig] writing INI to %s', CONFIG_INI_PATH);
      await fs.writeFile(CONFIG_INI_PATH, stringify(config as Record<string, unknown>));
      logger.info('[federation/setConfig] INI written successfully');

      if (input.enabled) {
        // Auto-generate keys if enabling and none exist
        const keys = await getLocalKeys();
        logger.info('[federation/setConfig] existing keys: %s', keys ? 'yes' : 'no');
        if (!keys) {
          logger.info('[federation/setConfig] generating federation keys...');
          await generateFederationKeys();
          logger.info('[federation/setConfig] keys generated');
        }
      } else {
        // Clean up when disabling federation: delete keys, instances, and shadow users
        logger.info('[federation/setConfig] disabling — cleaning up federation data');

        // Delete shadow users for each instance first (FK constraint)
        const instances = await db.select().from(federationInstances);
        for (const instance of instances) {
          await deleteShadowUsersByInstance(instance.id);
          logger.info('[federation/setConfig] deleted shadow users for instance %d (%s)', instance.id, instance.domain);
        }

        // Delete all federation instances
        await db.delete(federationInstances);
        logger.info('[federation/setConfig] deleted all federation instances');

        // Delete federation keys so new ones are generated on re-enable
        await db.delete(federationKeys);
        logger.info('[federation/setConfig] deleted federation keys');

        invalidateCorsCache();

        pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
          status: 'disabled'
        });
      }

      logger.info('[federation/setConfig] success');
      return { success: true };
    } catch (error) {
      logger.error('[federation/setConfig] error: %o', error);
      throw error;
    }
  });

export { setConfigRoute };
