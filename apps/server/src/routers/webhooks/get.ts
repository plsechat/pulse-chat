import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { webhooks } from '../../db/schema';
import { serverProcedure } from '../../utils/procedures';

const getWebhookRoute = serverProcedure(Permission.MANAGE_WEBHOOKS)
  .input(z.object({ webhookId: z.number().int().positive() }))
  .query(async ({ input, ctx }) => {
    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(
        and(
          eq(webhooks.id, input.webhookId),
          eq(webhooks.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    return webhook ?? null;
  });

export { getWebhookRoute };
