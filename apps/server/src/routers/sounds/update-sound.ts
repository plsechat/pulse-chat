import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishSound } from '../../db/publishers';
import { soundNameTaken } from '../../db/queries/sounds';
import { serverSounds } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { soundEmojiSchema, soundNameSchema, soundVolumeSchema } from './schemas';

/** Rename, re-emoji (null clears it) or re-level a clip of the active server. */
const updateSoundRoute = serverProcedure(Permission.MANAGE_SOUNDS)
  .input(
    z.object({
      soundId: z.number().int().positive(),
      name: soundNameSchema.optional(),
      emoji: soundEmojiSchema.nullable().optional(),
      volume: soundVolumeSchema.optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [existing] = await db
      .select({
        id: serverSounds.id,
        serverId: serverSounds.serverId,
        name: serverSounds.name
      })
      .from(serverSounds)
      .where(
        and(
          eq(serverSounds.id, input.soundId),
          eq(serverSounds.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    invariant(existing, { code: 'NOT_FOUND', message: 'Sound not found' });

    if (
      input.name !== undefined &&
      (await soundNameTaken(existing.serverId, input.name, existing.id))
    ) {
      ctx.throwValidationError('name', 'A sound with this name already exists.');
    }

    const patch: Partial<typeof serverSounds.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.emoji !== undefined) patch.emoji = input.emoji;
    if (input.volume !== undefined) patch.volume = input.volume;

    invariant(Object.keys(patch).length > 0, {
      code: 'BAD_REQUEST',
      message: 'Nothing to change'
    });

    await db.update(serverSounds).set(patch).where(eq(serverSounds.id, existing.id));

    publishSound(existing.id, 'update', existing.serverId);
    enqueueActivityLog({
      type: ActivityLogType.UPDATED_SOUND,
      userId: ctx.user.id,
      details: { name: patch.name ?? existing.name, changed: Object.keys(patch) }
    });
  });

export { updateSoundRoute };
