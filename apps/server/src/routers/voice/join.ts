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
import { assertNotTimedOut } from '../../utils/automod';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { removeUserFromVoice } from '../../utils/voice-cleanup';

const joinVoiceRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number().int().positive(),
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

    // An automod timeout keeps the member out of voice in this server
    // until the deadline (MANAGE_USERS bypasses). Checked before any
    // runtime is touched so a refused join leaves no state behind.
    await assertNotTimedOut(ctx, channel.serverId);

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

    // Instance-wide cap, checked after the self-heal so a rejoin does not
    // count its own stale session.
    VoiceRuntime.assertCapacity();

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

    // addUser merged any standing moderation override into the state;
    // (re)apply the SFU enforcement for media that already exists. Fresh
    // producers/consumers honour the flags at creation (produce/consume).
    const state = runtime.getUserState(ctx.user.id);
    if (state.serverMuted) await runtime.setAudioPaused(ctx.user.id, true);
    if (state.serverDeafened) {
      await runtime.setConsumersPaused(ctx.user.id, true);
    }

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
      kind: runtime.kind,
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
