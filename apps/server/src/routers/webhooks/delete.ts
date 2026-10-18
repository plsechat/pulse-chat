import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { webhooks } from '../../db/schema';
import { serverProcedure } from '../../utils/procedures';

const deleteWebhookRoute = serverProcedure(Permission.MANAGE_WEBHOOKS)
  .input(z.object({ webhookId: z.number().int().positive() }))
  .mutation(async ({ input, ctx }) => {
    await db
      .delete(webhooks)
      .where(
        and(
          eq(webhooks.id, input.webhookId),
          eq(webhooks.serverId, ctx.activeServerId)
        )
      );
  });

export { deleteWebhookRoute };
