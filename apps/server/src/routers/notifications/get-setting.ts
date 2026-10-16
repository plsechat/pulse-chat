import { ChannelPermission, NotificationLevel } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { channelNotificationSettings } from '../../db/schema';
import { channelProcedure } from '../../utils/procedures';

const getNotificationSettingRoute = channelProcedure(
  ChannelPermission.VIEW_CHANNEL
).query(async ({ ctx }) => {
  const [setting] = await db
    .select({ level: channelNotificationSettings.level })
    .from(channelNotificationSettings)
    .where(
      and(
        eq(channelNotificationSettings.userId, ctx.userId),
        eq(channelNotificationSettings.channelId, ctx.channel.id)
      )
    )
    .limit(1);

  return { level: (setting?.level ?? NotificationLevel.DEFAULT) as NotificationLevel };
});

export { getNotificationSettingRoute };
