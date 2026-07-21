import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  categories,
  channels,
  emojis,
  invites,
  messages,
  roles,
  servers,
  webhooks
} from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Per-server drill-down for the instance server directory: content and
 * structure counts the list view doesn't carry (messages via the
 * channel join — the only potentially large scan, kept out of the
 * all-servers listing on purpose).
 */
const getServerInfoRoute = instanceOwnerProcedure
  .input(
    z.object({
      serverId: z.number().int().positive()
    })
  )
  .query(async ({ input }) => {
    const [server] = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, input.serverId))
      .limit(1);

    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    const countWhere = async (
      table:
        | typeof categories
        | typeof roles
        | typeof invites
        | typeof emojis
        | typeof webhooks,
      column:
        | typeof categories.serverId
        | typeof roles.serverId
        | typeof invites.serverId
        | typeof emojis.serverId
        | typeof webhooks.serverId
    ) => {
      const [row] = await db
        .select({ value: count() })
        .from(table)
        .where(eq(column, input.serverId));
      return row?.value ?? 0;
    };

    const [messageCount] = await db
      .select({ value: count() })
      .from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .where(eq(channels.serverId, input.serverId));

    return {
      categoryCount: await countWhere(categories, categories.serverId),
      roleCount: await countWhere(roles, roles.serverId),
      inviteCount: await countWhere(invites, invites.serverId),
      emojiCount: await countWhere(emojis, emojis.serverId),
      webhookCount: await countWhere(webhooks, webhooks.serverId),
      messageCount: messageCount?.value ?? 0
    };
  });

export { getServerInfoRoute };
