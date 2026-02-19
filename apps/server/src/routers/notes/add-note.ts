import { ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { userNotes } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const addNoteRoute = protectedProcedure
  .input(
    z.object({
      targetUserId: z.number(),
      content: z.string().min(1).max(2000)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const [note] = await db
      .insert(userNotes)
      .values({
        authorId: ctx.userId,
        targetUserId: input.targetUserId,
        content: input.content,
        createdAt: Date.now()
      })
      .returning({
        id: userNotes.id,
        content: userNotes.content,
        createdAt: userNotes.createdAt
      });

    // Notify the same user across tabs
    ctx.pubsub.publishFor(ctx.userId, ServerEvents.USER_NOTE_UPDATE, {
      targetUserId: input.targetUserId
    });

    return note;
  });

export { addNoteRoute };
