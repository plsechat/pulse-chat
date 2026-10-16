import z from 'zod';
import { pluginManager } from '../../plugins';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { pluginIdSchema } from './schemas';

/**
 * The command list (names, descriptions, arg definitions — never
 * settings or logs) is readable by any member of the active server,
 * provided that server has plugin commands enabled.
 */
const getCommandsRoute = serverProcedure()
  .input(
    z.object({
      pluginId: pluginIdSchema.optional()
    })
  )
  .query(async ({ ctx, input }) => {
    invariant(
      await pluginManager.commandsEnabledForServer(ctx.activeServerId),
      {
        code: 'FORBIDDEN',
        message: 'Plugin commands are not enabled on this server'
      }
    );

    const allCommands = pluginManager.getCommands();

    if (input.pluginId) {
      const pluginCommands = allCommands[input.pluginId];

      return pluginCommands ? { [input.pluginId]: pluginCommands } : {};
    }

    return allCommands;
  });

export { getCommandsRoute };
