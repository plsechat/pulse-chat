import { ServerEvents } from '@pulse/shared';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const dmVoiceLeaveRoute = protectedProcedure.mutation(async ({ ctx }) => {
  invariant(ctx.currentDmVoiceChannelId, {
    code: 'BAD_REQUEST',
    message: 'Not in a DM voice call'
  });

  const runtime = VoiceRuntime.findById(ctx.currentDmVoiceChannelId);

  invariant(runtime, {
    code: 'INTERNAL_SERVER_ERROR',
    message: `Voice runtime not found for DM channel ${ctx.currentDmVoiceChannelId}`
  });

  const dmChannelId = ctx.currentDmVoiceChannelId;
  const memberIds = await getDmChannelMemberIds(dmChannelId);

  runtime.removeUser(ctx.user.id);

  ctx.pubsub.publishFor(memberIds, ServerEvents.DM_CALL_USER_LEFT, {
    dmChannelId,
    userId: ctx.userId
  });

  ctx.currentDmVoiceChannelId = undefined;
  ctx.currentVoiceChannelId = undefined;

  // Destroy runtime if no users remain
  if (runtime.getState().users.length === 0) {
    await runtime.destroy();

    ctx.pubsub.publishFor(memberIds, ServerEvents.DM_CALL_ENDED, {
      dmChannelId
    });
  }

  logger.info('%s left DM voice call %d', ctx.user.name, dmChannelId);
});

export { dmVoiceLeaveRoute };
