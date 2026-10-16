import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { userNotes } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const getNotesRoute = protectedProcedure
  .input(
    z.object({
      targetUserId: z.number().int().positive()
    })
  )
  .query(async ({ ctx, input }) => {
    const notes = await db
      .select({
        id: userNotes.id,
        content: userNotes.content,
        createdAt: userNotes.createdAt
      })
      .from(userNotes)
      .where(
        and(
          eq(userNotes.authorId, ctx.userId),
          eq(userNotes.targetUserId, input.targetUserId)
        )
      )
      .orderBy(desc(userNotes.createdAt));

    return { notes };
  });

export { getNotesRoute };
