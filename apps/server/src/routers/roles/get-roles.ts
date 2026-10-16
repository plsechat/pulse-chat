import { Permission } from '@pulse/shared';
import { getRolesForServer } from '../../db/queries/roles';
import { serverProcedureFor } from '../../utils/procedures';

const getRolesRouter = serverProcedureFor(Permission.MANAGE_ROLES).query(
  async ({ input }) => {
    const roles = await getRolesForServer(input.serverId);

    return roles;
  }
);

export { getRolesRouter };
