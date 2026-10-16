import z from 'zod';
import { pluginManager } from '../../plugins';
import { instanceOwnerProcedure } from '../../utils/procedures';
import { pluginIdSchema } from './schemas';

const getSettingsRoute = instanceOwnerProcedure
  .input(
    z.object({
      pluginId: pluginIdSchema
    })
  )
  .query(async ({ input }) => {
    return pluginManager.getPluginSettings(input.pluginId);
  });

export { getSettingsRoute };
