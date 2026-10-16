import { ServerEvents } from '@pulse/shared';
import { observable } from '@trpc/server/observable';
import { pluginManager } from '../../plugins';
import { instanceOwnerProcedure, serverProcedure } from '../../utils/procedures';

/**
 * Plugin log lines are an instance-operator surface: they carry
 * whatever the plugin chose to log (including command arguments), and
 * the plugin manager is a singleton for the whole instance. Only the
 * instance owner may stream them — same gate as `plugins.getLogs`.
 */
const onPluginLogRoute = instanceOwnerProcedure.subscription(
  async ({ ctx }) => {
    return ctx.pubsub.subscribe(ServerEvents.PLUGIN_LOG);
  }
);

/**
 * Command-list changes reach every member of the active server, but
 * only when that server has opted into plugin commands. The client
 * subscribes to this unconditionally on every server join, so a
 * server with plugins disabled gets a silent, empty stream instead
 * of a FORBIDDEN error on every connection.
 */
const onCommandsChangeRoute = serverProcedure().subscription(
  async ({ ctx }) => {
    if (!(await pluginManager.commandsEnabledForServer(ctx.activeServerId))) {
      return observable<never>(() => () => {});
    }

    return ctx.pubsub.subscribe(ServerEvents.PLUGIN_COMMANDS_CHANGE);
  }
);

export { onCommandsChangeRoute, onPluginLogRoute };
