import { getPublicUsersForServer } from '../../db/queries/users';
import { serverProcedure } from '../../utils/procedures';

const getServerMembersRoute = serverProcedure().query(async ({ ctx }) => {
  const publicUsers = await getPublicUsersForServer(ctx.activeServerId);

  return publicUsers.map((u) => ({
    ...u,
    status: ctx.getStatusById(u.id),
    _identity: u._identity?.includes('@') ? u._identity : undefined
  }));
});

export { getServerMembersRoute };
