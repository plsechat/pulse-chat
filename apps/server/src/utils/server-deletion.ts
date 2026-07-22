import { ChannelType } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { getFirstServer } from '../db/queries/servers';
import { channels, servers } from '../db/schema';
import { VoiceRuntime } from '../runtimes/voice';
import { invariant } from './invariant';

/**
 * Server-deletion core shared by the owner route (servers.delete) and
 * the operator route (admin.deleteServer): tear down live voice
 * runtimes, then let the FK cascades take the rows (files on disk
 * become orphans for the cleanup cron). Callers handle authorization.
 *
 * The instance's FIRST server is undeletable by either path: instance
 * ownership (isInstanceOwner) and federation identity both anchor on
 * it — deleting it would lock the operator out of the admin area.
 */
const deleteServerCore = async (serverId: number): Promise<void> => {
  const first = await getFirstServer();
  invariant(first === undefined || first.id !== serverId, {
    code: 'BAD_REQUEST',
    message:
      "The instance's first server anchors instance administration and cannot be deleted."
  });

  const voiceChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.serverId, serverId),
        eq(channels.type, ChannelType.VOICE)
      )
    );

  for (const vc of voiceChannels) {
    const runtime = VoiceRuntime.findById(vc.id);
    if (runtime) {
      await runtime.destroy();
    }
  }

  await db.delete(servers).where(eq(servers.id, serverId));
};

export { deleteServerCore };
