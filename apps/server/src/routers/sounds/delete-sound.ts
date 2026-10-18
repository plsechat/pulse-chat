import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { publishSound } from '../../db/publishers';
import { serverSounds } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

/** The clip's file dies with it (nothing else references a sound file). */
const deleteSoundRoute = serverProcedure(Permission.MANAGE_SOUNDS)
  .input(z.object({ soundId: z.number().int().positive() }))
  .mutation(async ({ input, ctx }) => {
    const [removed] = await db
      .delete(serverSounds)
      .where(
        and(
          eq(serverSounds.id, input.soundId),
          eq(serverSounds.serverId, ctx.activeServerId)
        )
      )
      .returning();

    invariant(removed, { code: 'NOT_FOUND', message: 'Sound not found' });

    await removeFile(removed.fileId);

    publishSound(removed.id, 'delete', removed.serverId);
    enqueueActivityLog({
      type: ActivityLogType.DELETED_SOUND,
      userId: ctx.user.id,
      details: { name: removed.name }
    });
  });

export { deleteSoundRoute };
