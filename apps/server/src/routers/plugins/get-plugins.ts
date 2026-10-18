import type { TCommandInfo, TPluginInfo } from '@pulse/shared';
import { pluginManager } from '../../plugins';
import { instanceOwnerProcedure } from '../../utils/procedures';

type TPluginListEntry = TPluginInfo & {
  /**
   * The plugin's registered commands (hidden sub-commands left out, as
   * the composer sees them). The instance panel reads them from here
   * rather than `getCommands`, which is scoped to the ACTIVE server's
   * Plugins switch — the instance owner must see what a plugin offers
   * even while the community they happen to be looking from has
   * commands turned off.
   */
  commands: TCommandInfo[];
};

// The plugin manager is a singleton for the whole instance, so listing,
// loading and configuring plugins is the instance owner's alone — not
// any server owner's (who holds every per-server permission on their
// own server).
const getPluginsRoute = instanceOwnerProcedure.query(async () => {
  const pluginIds = await pluginManager.getPluginsFromPath();
  const allCommands = pluginManager.getCommands();

  const pluginResults = await Promise.all(
    pluginIds.map(async (pluginId): Promise<TPluginListEntry | undefined> => {
      try {
        const info = await pluginManager.getPluginInfo(pluginId);

        return { ...info, commands: allCommands[pluginId] ?? [] };
      } catch {
        return undefined;
      }
    })
  );

  const plugins = pluginResults.filter(
    (plugin): plugin is TPluginListEntry => !!plugin
  );

  return {
    plugins
  };
});

export { getPluginsRoute };
