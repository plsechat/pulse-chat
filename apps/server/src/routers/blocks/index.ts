import { t } from '../../utils/trpc';
import { blockRoute } from './block';
import { onBlockChangedRoute } from './events';
import { getBlockedRoute } from './get-blocked';
import { unblockRoute } from './unblock';

export const blocksRouter = t.router({
  getBlocked: getBlockedRoute,
  block: blockRoute,
  unblock: unblockRoute,
  onBlockChanged: onBlockChangedRoute
});
