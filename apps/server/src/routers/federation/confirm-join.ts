import z from 'zod';
import { db } from '../../db';
import { federationInstances, userFederatedServers } from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { protectedProcedure } from '../../utils/trpc';

const confirmJoinRoute = protectedProcedure
  .input(
    z.object({
      instanceDomain: z.string(),
      remoteServerId: z.number(),
      remoteServerPublicId: z.string(),
      remoteServerName: z.string()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const [instance] = await db
      .select({ id: federationInstances.id })
      .from(federationInstances)
      .where(
        and(
          eq(federationInstances.domain, input.instanceDomain),
          eq(federationInstances.status, 'active')
        )
      )
      .limit(1);

    if (!instance) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Federation instance not found or not active'
      });
    }

    await db
      .insert(userFederatedServers)
      .values({
        userId: ctx.userId,
        instanceId: instance.id,
        remoteServerId: input.remoteServerId,
        remoteServerPublicId: input.remoteServerPublicId,
        remoteServerName: input.remoteServerName,
        joinedAt: Date.now()
      })
      .onConflictDoNothing();
  });

export { confirmJoinRoute };
