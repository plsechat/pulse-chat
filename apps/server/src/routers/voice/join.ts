import {
  ChannelPermission,
  ChannelType,
  Permission,
  ServerEvents
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels } from '../../db/schema';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { removeUserFromVoice } from '../../utils/voice-cleanup';

const joinVoiceRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      state: z.object({
        micMuted: z.boolean().default(false),
        soundMuted: z.boolean().default(false)
      })
    })
  )
  .mutation(async ({ input, ctx }) => {
    await Promise.all([
      ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS),
      ctx.needsChannelPermission(input.channelId, ChannelPermission.JOIN)
    ]);

    const [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    invariant(channel.type === ChannelType.VOICE, {
      code: 'BAD_REQUEST',
      message: 'Channel is not a voice channel'
    });

    // Self-heal instead of hard-failing: a page refresh (or dropped
    // connection) leaves the previous session's runtime entry behind,
    // and rejecting the rejoin bricked the user with "already in a
    // voice channel" until a server restart. Remove the stale session
    // (publishing the leave to peers) and proceed with the join.
    const userAlreadyInVoiceChannel = VoiceRuntime.findRuntimeByUserId(
      ctx.user.id
    );

    if (userAlreadyInVoiceChannel) {
      await removeUserFromVoice(ctx.user.id);
    }

    // Re-create runtime if it was destroyed when the last user left
    let runtime = VoiceRuntime.findById(input.channelId);

    if (!runtime) {
      runtime = new VoiceRuntime(input.channelId);
      try {
        await runtime.init();
      } catch (err) {
        await runtime.destroy();
        throw err;
      }
    }

    runtime.addUser(ctx.user.id, input.state);

    const state = runtime.getUserState(ctx.user.id);

    ctx.currentVoiceChannelId = channel.id;
    // A stale DM-call marker here would make the shared voice routes
    // resolve this session in the 'dm' keyspace — joining a server
    // channel definitively ends any DM-call association.
    ctx.currentDmVoiceChannelId = undefined;
    ctx.setWsVoiceKey(runtime.key);
    const startedAt = runtime.getState().startedAt!;
    const memberIds = await getServerMemberIds(channel.serverId);
    ctx.pubsub.publishFor(memberIds, ServerEvents.USER_JOIN_VOICE, {
      channelId: input.channelId,
      userId: ctx.user.id,
      state,
      startedAt
    });

    logger.info('%s joined voice channel %s', ctx.user.name, channel.name);

    const router = runtime.getRouter();

    return {
      routerRtpCapabilities: router.rtpCapabilities,
      startedAt: runtime.getState().startedAt
    };
  });

export { joinVoiceRoute };
