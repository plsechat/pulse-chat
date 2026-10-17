import { ActivityLogType, Permission, SOUNDS_PER_SERVER_MAX } from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { publishSound } from '../../db/publishers';
import { countServerSounds, soundNameTaken } from '../../db/queries/sounds';
import { serverSounds } from '../../db/schema';
import { logger } from '../../logger';
import { enqueueActivityLog } from '../../queues/activity-log';
import { fileManager } from '../../utils/file-manager';
import { invariant } from '../../utils/invariant';
import { serverProcedureFor } from '../../utils/procedures';
import {
  soundEmojiSchema,
  soundFileRejection,
  soundNameSchema,
  soundVolumeSchema
} from './schemas';

/**
 * Upload a soundboard clip: the file was staged through /upload (a temp
 * file token, like emoji), the route checks it is a small audio file,
 * then moves it to storage and writes the row. Bounds: 50 clips per
 * server, names unique per server (case-insensitively, so two clips do
 * not look alike in the grid).
 */
const addSoundRoute = serverProcedureFor(Permission.MANAGE_SOUNDS)
  .input(
    z.object({
      tempFileId: z.string().max(64),
      name: soundNameSchema,
      emoji: soundEmojiSchema.optional(),
      volume: soundVolumeSchema.default(100)
    })
  )
  .mutation(async ({ input, ctx }) => {
    const total = await countServerSounds(input.serverId);
    invariant(total < SOUNDS_PER_SERVER_MAX, {
      code: 'BAD_REQUEST',
      message: `A server can hold at most ${SOUNDS_PER_SERVER_MAX} sounds`
    });

    if (await soundNameTaken(input.serverId, input.name)) {
      ctx.throwValidationError('name', 'A sound with this name already exists.');
    }

    const tempFile = fileManager.getTemporaryFile(input.tempFileId);
    invariant(tempFile && tempFile.userId === ctx.userId, {
      code: 'NOT_FOUND',
      message: 'Uploaded file not found'
    });

    const rejection = soundFileRejection(
      tempFile,
      Bun.file(tempFile.path).type ?? ''
    );
    if (rejection) {
      // The staged file is useless now; free it rather than leaving it
      // for the temp sweep.
      await fileManager.removeTemporaryFile(tempFile.id);
      ctx.throwValidationError('file', rejection);
    }

    const file = await fileManager.saveFile(tempFile.id, ctx.userId);

    const [sound] = await db
      .insert(serverSounds)
      .values({
        serverId: input.serverId,
        name: input.name,
        fileId: file.id,
        emoji: input.emoji ?? null,
        volume: input.volume,
        createdBy: ctx.userId,
        createdAt: Date.now()
      })
      .returning();

    publishSound(sound!.id, 'create', input.serverId);
    enqueueActivityLog({
      type: ActivityLogType.CREATED_SOUND,
      userId: ctx.user.id,
      details: { name: sound!.name }
    });
    logger.info('%s added sound "%s" to server %d', ctx.user.name, sound!.name, input.serverId);

    return { id: sound!.id };
  });

export { addSoundRoute };
