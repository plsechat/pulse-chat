import { Permission } from '@pulse/shared';
import type { TBridgeRemoteGuild } from '../../types';
import { serverProcedure } from '../../utils/procedures';
import { listRemoteGuilds } from './bridge-_shared';

/** The picker's list for Server Settings → Bridge: the servers the bot sits in. */
const bridgeRemoteGuildsRoute = serverProcedure(Permission.MANAGE_SETTINGS).query(
  async (): Promise<TBridgeRemoteGuild[]> => listRemoteGuilds()
);

export { bridgeRemoteGuildsRoute };
