import { protectedProcedure } from '../../utils/trpc';

// Ends a read-only preview session (servers.preview). Called when the
// user backs out of the preview without joining.
const leavePreviewRoute = protectedProcedure.mutation(async ({ ctx }) => {
  ctx.previewServerId = undefined;
});

export { leavePreviewRoute };
