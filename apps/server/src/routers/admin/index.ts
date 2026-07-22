import { t } from '../../utils/trpc';
import { banUserRoute } from './ban-user';
import { deleteUserRoute } from './delete-user';
import { getServerInfoRoute } from './get-server-info';
import { listReportsRoute } from './list-reports';
import { listServersRoute } from './list-servers';
import { listUsersRoute } from './list-users';
import { resolveReportRoute } from './resolve-report';
import { getRegistrationRoute, setRegistrationRoute } from './registration';
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
  getRegistration: getRegistrationRoute,
  setRegistration: setRegistrationRoute,
  listReports: listReportsRoute,
  resolveReport: resolveReportRoute
});

export { adminRouter };
