import { ChannelPermission } from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { channelNotificationSettings } from '../../db/schema';
import { channelProcedure } from '../../utils/procedures';

const setNotificationSettingRoute = channelProcedure(
  ChannelPermission.VIEW_CHANNEL
)
  .input(
    z.object({
      level: z.enum(['all', 'mentions', 'nothing', 'default'])
    })
  )
  .mutation(async ({ ctx, input }) => {
    await db
      .insert(channelNotificationSettings)
      .values({
        userId: ctx.userId,
        channelId: ctx.channel.id,
        level: input.level,
        createdAt: Date.now()
      })
      .onConflictDoUpdate({
        target: [
          channelNotificationSettings.userId,
          channelNotificationSettings.channelId
        ],
        set: {
          level: input.level,
          updatedAt: Date.now()
        }
      });
  });

export { setNotificationSettingRoute };
