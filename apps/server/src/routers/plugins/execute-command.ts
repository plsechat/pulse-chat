import { ActivityLogType, Permission } from '@pulse/shared';
import z from 'zod';
import { getInvokerCtxFromTrpcCtx } from '../../helpers/get-invoker-ctx-from-trpc-ctx';
import { pluginManager } from '../../plugins';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import {
  commandArgsSchema,
  commandNameSchema,
  pluginIdSchema
} from './schemas';

/**
 * Any member holding EXECUTE_PLUGIN_COMMANDS may run a command, but only
 * from a server whose owner opted into plugin commands
 * (`servers.enablePlugins`). Loading/unloading plugins and everything
 * else on the plugins router is instance-owner-only; this per-server
 * flag gates command *execution* alone.
 */
const executeCommandRoute = serverProcedure(Permission.EXECUTE_PLUGIN_COMMANDS)
  .input(
    z.object({
      pluginId: pluginIdSchema,
      commandName: commandNameSchema,
      args: commandArgsSchema.optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    invariant(
      await pluginManager.commandsEnabledForServer(ctx.activeServerId),
      {
        code: 'FORBIDDEN',
        message: 'Plugin commands are not enabled on this server'
      }
    );

    invariant(pluginManager.hasCommand(input.pluginId, input.commandName), {
      code: 'BAD_REQUEST',
      message: `Command "${input.commandName}" not found for plugin "${input.pluginId}"`
    });

    const args = input.args ?? {};

    enqueueActivityLog({
      type: ActivityLogType.EXECUTED_PLUGIN_COMMAND,
      userId: ctx.user.id,
      details: {
        pluginId: input.pluginId,
        commandName: input.commandName,
        args: pluginManager.redactCommandArgs(
          input.pluginId,
          input.commandName,
          args
        )
      }
    });

    const response = await pluginManager.executeCommand(
      input.pluginId,
      input.commandName,
      getInvokerCtxFromTrpcCtx(ctx),
      args
    );

    return response;
  });

export { executeCommandRoute };
