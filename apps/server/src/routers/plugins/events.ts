import { ServerEvents } from '@pulse/shared';
import { observable } from '@trpc/server/observable';
import type { TCommandsMapByPlugin } from '@pulse/shared';
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
 * Command-list changes reach every member of the active server. The
 * client subscribes unconditionally on every server join; while the
 * server has plugin commands switched off it receives an empty map
 * rather than a FORBIDDEN error, and the stream stays live so the
 * switch flipping on (which publishes the list to the members) lands
 * without a reconnect.
 */
const onCommandsChangeRoute = serverProcedure().subscription(
  ({ ctx }) => {
    const serverId = ctx.activeServerId;

    return observable<TCommandsMapByPlugin>((emit) => {
      const forward = (commands: TCommandsMapByPlugin) => {
        void pluginManager
          .commandsEnabledForServer(serverId)
          .then((enabled) => emit.next(enabled ? commands : {}))
          .catch(() => emit.next({}));
      };
      // Registry changes are published to everyone; the Plugins switch
      // publishes to the community's members. Both land here.
      const everyone = ctx.pubsub
        .subscribe(ServerEvents.PLUGIN_COMMANDS_CHANGE)
        .subscribe({ next: forward, error: (err) => emit.error(err) });
      const mine = ctx.pubsub
        .subscribeFor(ctx.userId, ServerEvents.PLUGIN_COMMANDS_CHANGE)
        .subscribe({ next: forward, error: (err) => emit.error(err) });

      return () => {
        everyone.unsubscribe();
        mine.unsubscribe();
      };
    });
  }
);

export { onCommandsChangeRoute, onPluginLogRoute };
