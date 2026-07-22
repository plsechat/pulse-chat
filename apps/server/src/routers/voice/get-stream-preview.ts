import { ChannelPermission } from '@pulse/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { channelProcedure } from '../../utils/procedures';

// channelProcedure scopes to the caller's ACTIVE server, which also
// excludes read-only preview sessions structurally (they hold
// VIEW_CHANNEL on the previewed server but no active membership) — a
// previewer can't watch live screen shares.
const getStreamPreviewRoute = channelProcedure(ChannelPermission.VIEW_CHANNEL)
  .input(
    z.object({
      userId: z.number().int().positive()
    })
  )
  .query(async ({ input, ctx }) => {
    const runtime = VoiceRuntime.findById(ctx.channel.id);

    return { preview: runtime?.getStreamPreview(input.userId) ?? null };
  });

export { getStreamPreviewRoute };
