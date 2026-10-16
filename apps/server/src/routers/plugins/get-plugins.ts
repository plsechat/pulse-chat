import type { TPluginInfo } from '@pulse/shared';
import { pluginManager } from '../../plugins';
import { instanceOwnerProcedure } from '../../utils/procedures';

// The plugin manager is a singleton for the whole instance, so listing,
// loading and configuring plugins is the instance owner's alone — not
// any server owner's (who holds every per-server permission on their
// own server).
const getPluginsRoute = instanceOwnerProcedure.query(async () => {
  const pluginIds = await pluginManager.getPluginsFromPath();

  const pluginResults = await Promise.all(
    pluginIds.map(async (pluginId) => {
      try {
        const info = await pluginManager.getPluginInfo(pluginId);

        return info;
      } catch {
        return undefined;
      }
    })
  );

  const plugins = pluginResults.filter(
    (plugin): plugin is TPluginInfo => !!plugin
  );

  return {
    plugins
  };
});

export { getPluginsRoute };
