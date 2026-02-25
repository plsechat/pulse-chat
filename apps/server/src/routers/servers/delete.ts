import { ChannelType } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerById } from '../../db/queries/servers';
import { channels, servers } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deleteServerRoute = protectedProcedure
  .input(
    z.object({
      serverId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const server = await getServerById(input.serverId);

    invariant(server, {
      code: 'NOT_FOUND',
      message: 'Server not found'
    });

    invariant(server.ownerId === ctx.userId, {
      code: 'FORBIDDEN',
      message: 'Only the server owner can delete the server'
    });

    // Destroy any active voice runtimes for this server's channels
    const voiceChannels = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.serverId, input.serverId),
          eq(channels.type, ChannelType.VOICE)
        )
      );

    for (const vc of voiceChannels) {
      const runtime = VoiceRuntime.findById(vc.id);
      if (runtime) {
        await runtime.destroy();
      }
    }

    await db.delete(servers).where(eq(servers.id, input.serverId));
  });

export { deleteServerRoute };
