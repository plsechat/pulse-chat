import {
  VOICE_STREAM_PREVIEW_MAX_LENGTH,
  VOICE_STREAM_PREVIEW_PREFIX
} from '@pulse/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

// Pull model: the sharer stores its latest frame here and hover cards
// fetch it via voice.getStreamPreview — no pubsub fanout.
const updateStreamPreviewRoute = protectedProcedure
  .input(
    z.object({
      preview: z
        .string()
        .max(VOICE_STREAM_PREVIEW_MAX_LENGTH)
        .startsWith(VOICE_STREAM_PREVIEW_PREFIX)
    })
  )
  .mutation(async ({ input, ctx }) => {
    invariant(ctx.currentVoiceChannelId, {
      code: 'BAD_REQUEST',
      message: 'User is not in a voice channel'
    });

    const runtime = VoiceRuntime.requireById(ctx.currentVoiceChannelId);

    invariant(runtime.getUserState(ctx.user.id).sharingScreen, {
      code: 'BAD_REQUEST',
      message: 'User is not sharing their screen'
    });

    runtime.setStreamPreview(ctx.user.id, input.preview);
  });

export { updateStreamPreviewRoute };
