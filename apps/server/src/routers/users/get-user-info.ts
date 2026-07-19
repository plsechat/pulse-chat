import { Permission } from '@pulse/shared';
import z from 'zod';
import { getFilesByUserId } from '../../db/queries/files';
import { getLastLogins } from '../../db/queries/logins';
import { getMessagesByUserId } from '../../db/queries/messages';
import { getJoinMethod, isServerMember } from '../../db/queries/servers';
import { getAuditLogForUser } from '../../db/queries/activity-log';
import { getUserById } from '../../db/queries/users';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getUserInfoRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number()
    })
  )
  .query(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_USERS);

    // Verify target user is a member of the caller's active server
    const isMember = await isServerMember(ctx.activeServerId!, input.userId);

    invariant(isMember, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    const user = await getUserById(input.userId);

    invariant(user, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    const [logins, files, messages, auditLog, joinMethod] = await Promise.all([
      getLastLogins(user.id, 6),
      getFilesByUserId(user.id),
      getMessagesByUserId(user.id),
      getAuditLogForUser(user.id, ctx.activeServerId!),
      getJoinMethod(ctx.activeServerId!, user.id)
    ]);

    return { user, logins, files, messages, auditLog, joinMethod };
  });

export { getUserInfoRoute };
