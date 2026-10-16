import z from 'zod';
import { pluginManager } from '../../plugins';
import { instanceOwnerProcedure } from '../../utils/procedures';
import { pluginIdSchema } from './schemas';

const getPluginLogsRoute = instanceOwnerProcedure
  .input(
    z.object({
      pluginId: pluginIdSchema
    })
  )
  .query(async ({ input }) => {
    const logs = await pluginManager.getLogs(input.pluginId);

    return logs;
  });

export { getPluginLogsRoute };
