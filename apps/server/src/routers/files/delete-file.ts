import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { publishMessage } from '../../db/publishers';
import { getMessageByFileId } from '../../db/queries/messages';
import { files } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deleteFileRoute = protectedProcedure
  .input(z.object({ fileId: z.number() }))
  .mutation(async ({ input, ctx }) => {
    const [file] = await db
      .select({ userId: files.userId })
      .from(files)
      .where(eq(files.id, input.fileId))
      .limit(1);

    invariant(file, {
      code: 'NOT_FOUND',
      message: `File ${input.fileId} not found`
    });

    invariant(file.userId === ctx.userId, {
      code: 'FORBIDDEN',
      message: 'You do not have permission to delete this file'
    });

    const message = await getMessageByFileId(input.fileId);

    await removeFile(input.fileId);

    if (!message) return;

    publishMessage(message.id, message.channelId, 'update');
  });

export { deleteFileRoute };
