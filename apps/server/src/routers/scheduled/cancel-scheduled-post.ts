import { Permission } from '@pulse/shared';
import { z } from 'zod';
import {
  cancelScheduledPost,
  getScheduledPostInServer,
  publishScheduledPostUpdate
} from '../../db/queries/scheduled-posts';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

/** The author or a MANAGE_MESSAGES holder; a row already sent or cancelled is left alone. */
const cancelScheduledPostRoute = serverProcedure()
  .input(z.object({ scheduledPostId: z.number().int().positive() }))
  .mutation(async ({ input, ctx }) => {
    const row = await getScheduledPostInServer(input.scheduledPostId, ctx.activeServerId);

    invariant(row, { code: 'NOT_FOUND', message: 'Scheduled message not found' });

    invariant(
      row.post.userId === ctx.userId ||
        (await ctx.hasPermission(Permission.MANAGE_MESSAGES)),
      {
        code: 'FORBIDDEN',
        message: 'You do not have permission to cancel this message'
      }
    );

    const cancelled = await cancelScheduledPost(row.post.id, Date.now());

    if (cancelled) publishScheduledPostUpdate(row.channel.id);

    return { cancelled };
  });

export { cancelScheduledPostRoute };
