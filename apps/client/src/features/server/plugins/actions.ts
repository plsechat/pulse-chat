import { store } from '@/features/store';
import type { TCommandsMapByPlugin } from '@pulse/shared';
import { serverSliceActions } from '../slice';

export const setPluginCommands = (commands: TCommandsMapByPlugin) =>
  store.dispatch(serverSliceActions.setPluginCommands(commands));
