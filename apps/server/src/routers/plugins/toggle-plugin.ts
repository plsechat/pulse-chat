import { ActivityLogType } from '@pulse/shared';
import { z } from 'zod';
import { publishPluginCommands } from '../../db/publishers';
import { pluginManager } from '../../plugins';
import { enqueueActivityLog } from '../../queues/activity-log';
import { instanceOwnerProcedure } from '../../utils/procedures';
import { pluginIdSchema } from './schemas';

const togglePluginRoute = instanceOwnerProcedure
  .input(
    z.object({
      pluginId: pluginIdSchema,
      enabled: z.boolean()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await pluginManager.togglePlugin(input.pluginId, input.enabled);

    publishPluginCommands();
    enqueueActivityLog({
      type: ActivityLogType.PLUGIN_TOGGLED,
      userId: ctx.user.id,
      details: {
        pluginId: input.pluginId,
        enabled: input.enabled
      }
    });
  });

export { togglePluginRoute };
