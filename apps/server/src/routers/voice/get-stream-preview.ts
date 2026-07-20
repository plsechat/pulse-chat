import { ChannelPermission } from '@pulse/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { refuseInPreview } from '../../utils/preview-guard';
import { protectedProcedure } from '../../utils/trpc';

const getStreamPreviewRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number().int().positive(),
      userId: z.number().int().positive()
    })
  )
  .query(async ({ input, ctx }) => {
    // Previewers hold VIEW_CHANNEL on public channels — carve them out
    // explicitly so a read-only session can't watch live screen shares.
    await refuseInPreview(ctx, input.channelId);
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    const runtime = VoiceRuntime.findById(input.channelId);

    return { preview: runtime?.getStreamPreview(input.userId) ?? null };
  });

export { getStreamPreviewRoute };
