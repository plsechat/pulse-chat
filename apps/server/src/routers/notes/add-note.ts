import { invariant } from '../../utils/invariant';
import { getUserById } from '../../db/queries/users';
import { ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { userNotes } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const addNoteRoute = protectedProcedure
  .input(
    z.object({
      targetUserId: z.number().int().positive(),
      content: z.string().min(1).max(2000)
    })
  )
  .mutation(async ({ ctx, input }) => {
    // An unknown id would otherwise surface as a foreign-key error from
    // the insert; answer like any other missing user.
    invariant(await getUserById(input.targetUserId), {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

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
