import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { removeUserFromVoice } from '../../utils/voice-cleanup';

const dmVoiceLeaveRoute = protectedProcedure.mutation(async ({ ctx }) => {
  // Fall back to the runtime lookup when the per-connection context has
  // no channel — after a refresh the new connection never joined, but
  // the user's stale session may still occupy the call.
  let runtime = ctx.currentDmVoiceChannelId
    ? VoiceRuntime.findById(ctx.currentDmVoiceChannelId, 'dm')
    : undefined;

  if (!runtime) {
    const found = VoiceRuntime.findRuntimeByUserId(ctx.user.id);
    if (found?.isDmVoice) runtime = found;
  }

  invariant(runtime && runtime.getUser(ctx.user.id), {
    code: 'BAD_REQUEST',
    message: 'Not in a DM voice call'
  });

  const dmChannelId = runtime.id;

  await removeUserFromVoice(ctx.user.id);

  ctx.currentDmVoiceChannelId = undefined;
  ctx.currentVoiceChannelId = undefined;
  ctx.setWsVoiceKey(undefined);

  logger.info('%s left DM voice call %d', ctx.user.name, dmChannelId);
});

export { dmVoiceLeaveRoute };
