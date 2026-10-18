import { Permission } from '@pulse/shared';
import { getInvites } from '../../db/queries/invites';
import { serverProcedureFor } from '../../utils/procedures';

const getInvitesRoute = serverProcedureFor(Permission.MANAGE_INVITES).query(
  async ({ input }) => {
    const invites = await getInvites(input.serverId);

    return invites;
  }
);

export { getInvitesRoute };
