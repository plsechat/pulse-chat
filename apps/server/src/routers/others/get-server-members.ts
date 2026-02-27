import { getPublicUsersForServer } from '../../db/queries/users';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getServerMembersRoute = protectedProcedure.query(async ({ ctx }) => {
  invariant(ctx.activeServerId, {
    code: 'BAD_REQUEST',
    message: 'No active server'
  });

  const publicUsers = await getPublicUsersForServer(ctx.activeServerId);

  return publicUsers.map((u) => ({
    ...u,
    status: ctx.getStatusById(u.id),
    _identity: u._identity?.includes('@') ? u._identity : undefined
  }));
});

export { getServerMembersRoute };
