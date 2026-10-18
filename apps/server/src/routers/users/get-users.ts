import { Permission } from '@pulse/shared';
import { getUsers } from '../../db/queries/users';
import { clearFields } from '../../helpers/clear-fields';
import { serverProcedure } from '../../utils/procedures';

// The active server's members only — with no active server this used to
// list every account on the instance.
const getUsersRoute = serverProcedure(Permission.MANAGE_USERS).query(async ({ ctx }) => {
  const users = await getUsers(ctx.activeServerId);

  return clearFields(users, ['supabaseId']);
});

export { getUsersRoute };
