import { Permission } from '@pulse/shared';
import { z } from 'zod';
import {
  buildPollView,
  closePoll,
  getPollInServer,
  publishPollUpdate
} from '../../db/queries/polls';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

/** The author or a MANAGE_MESSAGES holder ends the poll early; idempotent. */
const closePollRoute = serverProcedure()
  .input(z.object({ pollId: z.number().int().positive() }))
  .mutation(async ({ input, ctx }) => {
    const row = await getPollInServer(input.pollId, ctx.activeServerId);

    invariant(row, { code: 'NOT_FOUND', message: 'Poll not found' });

    invariant(
      row.poll.createdBy === ctx.userId ||
        (await ctx.hasPermission(Permission.MANAGE_MESSAGES)),
      {
        code: 'FORBIDDEN',
        message: 'You do not have permission to close this poll'
      }
    );

    const wasOpen = row.poll.closedAt === null;
    const poll = (await closePoll(row.poll.id, Date.now())) ?? row.poll;

    if (wasOpen) publishPollUpdate(poll);

    return buildPollView(poll, ctx.userId);
  });

export { closePollRoute };
