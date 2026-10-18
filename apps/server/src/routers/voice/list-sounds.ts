import { Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { getServerSounds } from '../../db/queries/sounds';
import { channels } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

/**
 * The soundboard of the room this connection is in. Resolved from the
 * session rather than the active server: the grid opens from the call
 * controls, which stay up while the user browses another server, and
 * the clips belong to the server hosting the call. DM calls have no
 * soundboard. `canPlay` tells the grid whether to offer the clips or
 * explain that the member lacks USE_SOUNDBOARD there.
 */
const listSoundsRoute = protectedProcedure.query(async ({ ctx }) => {
  const runtime = VoiceRuntime.findByCtx(ctx);

  invariant(runtime && !runtime.isDmVoice && runtime.getUser(ctx.user.id), {
    code: 'BAD_REQUEST',
    message: 'User is not in a voice channel'
  });

  const [channel] = await db
    .select({ serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, runtime.id))
    .limit(1);

  invariant(channel, {
    code: 'BAD_REQUEST',
    message: 'User is not in a voice channel'
  });

  const [sounds, canPlay] = await Promise.all([
    getServerSounds(channel.serverId),
    ctx.hasPermission(Permission.USE_SOUNDBOARD, channel.serverId)
  ]);

  return { serverId: channel.serverId, sounds, canPlay };
});

export { listSoundsRoute };
