import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels } from '../../db/schema';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const leaveVoiceRoute = protectedProcedure.mutation(async ({ ctx }) => {
  await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

  invariant(ctx.currentVoiceChannelId, {
    code: 'BAD_REQUEST',
    message: 'User is not in a voice channel'
  });

  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, ctx.currentVoiceChannelId))
    .limit(1);

  invariant(channel, {
    code: 'NOT_FOUND',
    message: 'Channel not found'
  });

  invariant(channel.type === ChannelType.VOICE, {
    code: 'BAD_REQUEST',
    message: 'Channel is not a voice channel'
  });

  const runtime = VoiceRuntime.findById(ctx.currentVoiceChannelId);

  invariant(runtime, {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Voice runtime not found for this channel'
  });

  const userInChannel = runtime.getUser(ctx.user.id);

  invariant(userInChannel, {
    code: 'BAD_REQUEST',
    message: 'User not in voice channel'
  });

  runtime.removeUser(ctx.user.id);

  const memberIds = await getServerMemberIds(channel.serverId);
  ctx.pubsub.publishFor(memberIds, ServerEvents.USER_LEAVE_VOICE, {
    channelId: ctx.currentVoiceChannelId,
    userId: ctx.user.id,
    startedAt: runtime.getState().startedAt
  });
  ctx.currentVoiceChannelId = undefined;

  // Destroy the runtime when no users remain to free mediasoup resources
  if (runtime.getState().users.length === 0) {
    await runtime.destroy();
  }

  logger.info('%s left voice channel %s', ctx.user.name, channel.name);
});

export { leaveVoiceRoute };
