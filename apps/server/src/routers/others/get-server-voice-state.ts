import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { serverProcedure } from '../../utils/procedures';

const getServerVoiceStateRoute = serverProcedure().query(async ({ ctx }) => {
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
