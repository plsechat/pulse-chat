import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { toWireChannel } from '../../db/queries/channels';
import { channels } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const getChannelRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(
    z.object({
      channelId: z.number().int().positive()
    })
  )
  .query(async ({ input, ctx }) => {
    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.serverId, ctx.activeServerId)))
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    return toWireChannel(channel);
  });

export { getChannelRoute };
