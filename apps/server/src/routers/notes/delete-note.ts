import { ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { userNotes } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const deleteNoteRoute = protectedProcedure
  .input(
    z.object({
      noteId: z.number()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const [deleted] = await db
      .delete(userNotes)
      .where(
        and(
          eq(userNotes.id, input.noteId),
          eq(userNotes.authorId, ctx.userId)
        )
      )
      .returning({ targetUserId: userNotes.targetUserId });

    if (deleted) {
      // Notify the same user across tabs
      ctx.pubsub.publishFor(ctx.userId, ServerEvents.USER_NOTE_UPDATE, {
        targetUserId: deleted.targetUserId
      });
    }
  });

export { deleteNoteRoute };
