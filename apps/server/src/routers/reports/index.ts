import { t } from '../../utils/trpc';
import { createReportRoute } from './create';
import { listServerQueueRoute } from './list-server-queue';
import { resolveServerRoute } from './resolve-server';

const reportsRouter = t.router({
  create: createReportRoute,
  listServerQueue: listServerQueueRoute,
  resolveServer: resolveServerRoute
});

export { reportsRouter };
