import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import { setPluginCommands } from './actions';

const subscribeToPlugins = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onCommandsChange', trpc.plugins.onCommandsChange, (data) =>
      setPluginCommands(data)
    )
  );
};

export { subscribeToPlugins };
