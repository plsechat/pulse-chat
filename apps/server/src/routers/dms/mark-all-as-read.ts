import { ServerEvents } from '@pulse/shared';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { protectedProcedure } from '../../utils/trpc';

/**
 * One statement for every DM the caller is in: the newest message id
 * per channel becomes the read marker (insert or update). The previous
 * version ran one newest-message query plus one upsert per channel.
 * Channels without messages produce no row — nothing to read there.
 */
const markAllAsReadRoute = protectedProcedure.mutation(async ({ ctx }) => {
  const now = Date.now();

  const written = await db.execute<{
    dmChannelId: number;
    lastReadMessageId: number;
  }>(sql`
    INSERT INTO dm_read_states (user_id, dm_channel_id, last_read_message_id, last_read_at)
    SELECT ${ctx.userId}, m.dm_channel_id, max(m.id), ${now}
    FROM dm_messages m
    INNER JOIN dm_channel_members cm
      ON cm.dm_channel_id = m.dm_channel_id AND cm.user_id = ${ctx.userId}
    GROUP BY m.dm_channel_id
    ON CONFLICT (user_id, dm_channel_id) DO UPDATE SET
      last_read_message_id = excluded.last_read_message_id,
      last_read_at = excluded.last_read_at
    RETURNING dm_channel_id AS "dmChannelId", last_read_message_id AS "lastReadMessageId"
  `);

  for (const row of written) {
    ctx.pubsub.publishFor(ctx.userId, ServerEvents.DM_READ_STATE_UPDATE, {
      dmChannelId: row.dmChannelId,
      lastReadMessageId: row.lastReadMessageId
    });
  }

  return { success: true };
});

export { markAllAsReadRoute };
