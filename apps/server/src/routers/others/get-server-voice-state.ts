import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getServerVoiceStateRoute = protectedProcedure.query(async ({ ctx }) => {
  invariant(ctx.activeServerId, {
    code: 'BAD_REQUEST',
    message: 'No active server'
  });

  const serverChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.serverId, ctx.activeServerId));

  const channelIds = new Set(serverChannels.map((c) => c.id));

  return {
    voiceMap: VoiceRuntime.getVoiceMap(channelIds),
    externalStreamsMap: VoiceRuntime.getExternalStreamsMap(channelIds)
  };
});

export { getServerVoiceStateRoute };
