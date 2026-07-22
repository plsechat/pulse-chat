import { t } from '../../utils/trpc';
import { banUserRoute } from './ban-user';
import { deleteServerAdminRoute } from './delete-server';
import { deleteUserRoute } from './delete-user';
import { getActivityLogRoute } from './get-activity-log';
import { getHealthRoute } from './get-health';
import { getMetricsRoute } from './get-metrics';
import { getRecentLogsRoute } from './get-recent-logs';
import { getServerInfoRoute } from './get-server-info';
import { getStorageRoute, runStorageCleanupRoute } from './get-storage';
import { listReportsRoute } from './list-reports';
import { listServersRoute } from './list-servers';
import { listUsersRoute } from './list-users';
import { resolveReportRoute } from './resolve-report';
import { getRegistrationRoute, setRegistrationRoute } from './registration';
import { getScreenLimitsRoute, setScreenLimitsRoute } from './screen-limits';
import { unbanUserRoute } from './unban-user';

/**
 * Instance administration — every procedure here is built on
 * instanceOwnerProcedure (utils/procedures.ts): the bootstrap-server
 * owner alone. Instance-level federation management lives in the
 * federation router, gated the same way.
 */
const adminRouter = t.router({
  listUsers: listUsersRoute,
  listServers: listServersRoute,
  getServerInfo: getServerInfoRoute,
  banUser: banUserRoute,
  unbanUser: unbanUserRoute,
  deleteUser: deleteUserRoute,
  deleteServer: deleteServerAdminRoute,
  getRegistration: getRegistrationRoute,
  setRegistration: setRegistrationRoute,
  getScreenLimits: getScreenLimitsRoute,
  setScreenLimits: setScreenLimitsRoute,
  listReports: listReportsRoute,
  resolveReport: resolveReportRoute,
  getHealth: getHealthRoute,
  getMetrics: getMetricsRoute,
  getActivityLog: getActivityLogRoute,
  getStorage: getStorageRoute,
  runStorageCleanup: runStorageCleanupRoute,
  getRecentLogs: getRecentLogsRoute
});

export { adminRouter };
