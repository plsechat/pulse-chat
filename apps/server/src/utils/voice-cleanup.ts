import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { getServerMemberIds } from '../db/queries/servers';
import { channels } from '../db/schema';
import { logger } from '../logger';
import { VoiceRuntime } from '../runtimes/voice';
import { pubsub } from './pubsub';

/**
 * Remove a user from whatever voice runtime they occupy and publish the
 * departure exactly like a voluntary leave: USER_LEAVE_VOICE to the
 * audience (server members or DM members), the DM call lifecycle events,
 * and destroy-if-empty to free mediasoup resources.
 *
 * Shared by every involuntary removal path — WS close, self-healing
 * rejoin, moderator disconnect, channel/server/DM teardown, and the
 * orphan sweep — so no path can forget one of the publishes.
 *
 * Returns false when the user is not in any voice runtime (idempotent).
 */
const removeUserFromVoice = async (userId: number): Promise<boolean> => {
  const runtime = VoiceRuntime.findRuntimeByUserId(userId);
  if (!runtime) return false;

  runtime.removeUser(userId);

  if (runtime.isDmVoice) {
    // Dynamic import mirrors the WS close handler — avoids a static
    // import cycle through db/queries/dms.
    const { getDmChannelMemberIds } = await import('../db/queries/dms');
    const memberIds = await getDmChannelMemberIds(runtime.id);

    pubsub.publishFor(memberIds, ServerEvents.USER_LEAVE_VOICE, {
      channelId: runtime.id,
      kind: runtime.kind,
      userId,
      startedAt: runtime.getState().startedAt
    });

    if (runtime.getState().users.length === 0) {
      await runtime.destroy();
      pubsub.publishFor(memberIds, ServerEvents.DM_CALL_ENDED, {
        dmChannelId: runtime.id
      });
    } else {
      pubsub.publishFor(memberIds, ServerEvents.DM_CALL_USER_LEFT, {
        dmChannelId: runtime.id,
        userId
      });
    }
  } else {
    const [ch] = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, runtime.id))
      .limit(1);

    if (ch) {
      const memberIds = await getServerMemberIds(ch.serverId);
      pubsub.publishFor(memberIds, ServerEvents.USER_LEAVE_VOICE, {
        channelId: runtime.id,
        kind: runtime.kind,
        userId,
        startedAt: runtime.getState().startedAt
      });
    }

    if (runtime.getState().users.length === 0) {
      await runtime.destroy();
    }
  }

  logger.debug('[voice-cleanup] removed user %d from channel %d', userId, runtime.id);
  return true;
};

/**
 * Tear down a whole room the way its occupants would experience a
 * forced leave: every user is removed through removeUserFromVoice (so
 * peers get USER_LEAVE_VOICE and a DM call ends with DM_CALL_ENDED),
 * then the runtime is destroyed. A bare `runtime.destroy()` closed the
 * mediasoup objects but told nobody — clients stayed "connected" to a
 * room that no longer existed until they reloaded.
 *
 * Callers that are about to delete the channel/server row must call
 * this BEFORE the delete: the leave fan-out resolves its audience
 * through the channel's row.
 */
const evictRuntime = async (runtime: VoiceRuntime): Promise<void> => {
  for (const user of [...runtime.getState().users]) {
    await removeUserFromVoice(user.userId);
  }

  // The last removal already destroyed it; an empty room needs the
  // explicit teardown (destroy is idempotent).
  await runtime.destroy();
};

export { evictRuntime, removeUserFromVoice };
