import { ServerEvents } from '@pulse/shared';
import { stringify } from 'ini';
import fs from 'node:fs/promises';
import z from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { deleteShadowUsersByInstance } from '../../db/mutations/federation';
import { federationInstances, federationKeys } from '../../db/schema';
import { CONFIG_INI_PATH } from '../../helpers/paths';
import { invalidateCorsCache } from '../../http/cors';
import { logger } from '../../logger';
import {
  generateFederationKeys,
  getLocalKeys
} from '../../utils/federation';
import { pubsub } from '../../utils/pubsub';
import { instanceOwnerProcedure } from '../../utils/procedures';

const setConfigRoute = instanceOwnerProcedure
  .input(
    z.object({
      enabled: z.boolean(),
      domain: z.string().min(1),
      // Instance-owner policy: whether non-owner server owners may mark
      // their own servers federatable. Omitted → left unchanged.
      allowUserFederatableServers: z.boolean().optional()
    })
  )
  .mutation(async ({ input }) => {
    try {

      // Mutate config in memory
      config.federation.enabled = input.enabled;
      config.federation.domain = input.domain;
      if (input.allowUserFederatableServers !== undefined) {
        config.federation.allowUserFederatableServers =
          input.allowUserFederatableServers;
      }

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
