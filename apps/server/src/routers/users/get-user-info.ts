import { Permission } from '@pulse/shared';
import z from 'zod';
import { getFilesByUserId } from '../../db/queries/files';
import { getLastLogins } from '../../db/queries/logins';
import { getMessagesByUserId } from '../../db/queries/messages';
import { getJoinMethod, isServerMember } from '../../db/queries/servers';
import { getAuditLogForUser } from '../../db/queries/activity-log';
import { getUserById } from '../../db/queries/users';
import { clearFields } from '../../helpers/clear-fields';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const getUserInfoRoute = serverProcedure(Permission.MANAGE_USERS)
  .input(
    z.object({
      userId: z.number().int().positive()
    })
  )
  .query(async ({ ctx, input }) => {
    // Verify target user is a member of the caller's active server
    const isMember = await isServerMember(ctx.activeServerId, input.userId);

    invariant(isMember, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    const fullUser = await getUserById(input.userId);

    invariant(fullUser, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    // The auth-backend subject id is an internal identifier; blank it the
    // way users.getAll does (the shape stays, the value never leaves).
    const user = clearFields(fullUser, ['supabaseId']);

    const [logins, files, messages, auditLog, joinMethod] = await Promise.all([
      getLastLogins(user.id, 6),
      getFilesByUserId(user.id, ctx.activeServerId),
      getMessagesByUserId(user.id, ctx.activeServerId),
      getAuditLogForUser(user.id, ctx.activeServerId),
      getJoinMethod(ctx.activeServerId, user.id)
    ]);

    return { user, logins, files, messages, auditLog, joinMethod };
  });

export { getUserInfoRoute };
