import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmChannels } from '../../db/schema';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { removeUserFromVoice } from '../../utils/voice-cleanup';

const dmVoiceJoinRoute = protectedProcedure
  .input(
    z.object({
      dmChannelId: z.number(),
      state: z.object({
        micMuted: z.boolean().default(false),
        soundMuted: z.boolean().default(false)
      })
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [channel] = await db
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.id, input.dmChannelId))
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'DM channel not found'
    });

    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'Not a member of this DM channel'
    });

    // Self-heal instead of hard-failing — same rationale as voice/join:
    // a refresh strands the previous session in the runtime and the
    // rejoin must clear it, not brick the user.
    const userAlreadyInVoice = VoiceRuntime.findRuntimeByUserId(ctx.user.id);

    if (userAlreadyInVoice) {
      await removeUserFromVoice(ctx.user.id);
    }

    // Get or create a voice runtime for this DM channel
    let runtime = VoiceRuntime.findById(input.dmChannelId);
    const isNewCall = !runtime;

    if (!runtime) {
      runtime = new VoiceRuntime(input.dmChannelId, true);
      try {
        await runtime.init();
      } catch (err) {
        await runtime.destroy();
        throw err;
      }
    }

    runtime.addUser(ctx.user.id, input.state);

    ctx.currentDmVoiceChannelId = input.dmChannelId;
    ctx.currentVoiceChannelId = input.dmChannelId;
    ctx.setWsVoiceChannelId(input.dmChannelId);

    const state = runtime.getUserState(ctx.user.id);

    if (isNewCall) {
      ctx.pubsub.publishFor(memberIds, ServerEvents.DM_CALL_STARTED, {
        dmChannelId: input.dmChannelId,
        startedBy: ctx.userId
      });
    }

    ctx.pubsub.publishFor(memberIds, ServerEvents.DM_CALL_USER_JOINED, {
      dmChannelId: input.dmChannelId,
      userId: ctx.userId,
      state
    });

    logger.info('%s joined DM voice call %d', ctx.user.name, input.dmChannelId);

    const router = runtime.getRouter();

    return {
      routerRtpCapabilities: router.rtpCapabilities
    };
  });

export { dmVoiceJoinRoute };
