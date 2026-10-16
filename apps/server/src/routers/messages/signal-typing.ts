import { ChannelPermission, ServerEvents, TYPING_MS } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { channels } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { refuseInPreview } from '../../utils/preview-guard';
import { serverProcedure } from '../../utils/procedures';

/**
 * Per-(user, channel) floor between accepted typing signals. The client
 * throttles at TYPING_MS; the server floor sits below it so a legitimate
 * client never trips it through timer/network jitter, while a flood is
 * cut to one fan-out per window instead of one per call. Over-limit
 * signals are dropped silently — typing is best-effort and the client
 * ignores the result anyway.
 */
const TYPING_SIGNAL_MIN_INTERVAL_MS = Math.floor(TYPING_MS * 0.75);

/** Prune expired entries once the map grows past this many keys. */
const TYPING_SIGNAL_PRUNE_THRESHOLD = 10_000;

const lastTypingSignalAt = new Map<string, number>();

const pruneTypingSignals = (now: number) => {
  if (lastTypingSignalAt.size < TYPING_SIGNAL_PRUNE_THRESHOLD) return;

  for (const [key, at] of lastTypingSignalAt) {
    if (now - at >= TYPING_SIGNAL_MIN_INTERVAL_MS) {
      lastTypingSignalAt.delete(key);
    }
  }
};

/** True when this signal is inside the floor and must be dropped. */
const isTypingSignalRateLimited = (
  userId: number,
  channelId: number,
  now = Date.now()
): boolean => {
  const key = `${userId}:${channelId}`;
  const last = lastTypingSignalAt.get(key);

  if (last !== undefined && now - last < TYPING_SIGNAL_MIN_INTERVAL_MS) {
    return true;
  }

  pruneTypingSignals(now);
  lastTypingSignalAt.set(key, now);

  return false;
};

const signalTypingRoute = serverProcedure()
  .input(
    z.object({
      channelId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Previewers are invisible to members — no typing fan-out. Checked
    // before the scope lookup so a previewer gets the read-only reason
    // rather than "not found".
    await refuseInPreview(ctx, input.channelId);

    // Scope to the active server: a channel elsewhere reads as
    // nonexistent, so the fan-out can't be pointed at channels (and
    // their viewer sets) in servers the caller is not active in.
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.id, input.channelId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.SEND_MESSAGES
    );

    if (isTypingSignalRateLimited(ctx.userId, input.channelId)) {
      return;
    }

    const affectedUserIds = await getAffectedUserIdsForChannel(
      input.channelId,
      { permission: ChannelPermission.VIEW_CHANNEL }
    );
    ctx.pubsub.publishFor(affectedUserIds, ServerEvents.MESSAGE_TYPING, {
      channelId: input.channelId,
      userId: ctx.userId
    });
  });

export {
  isTypingSignalRateLimited,
  signalTypingRoute,
  TYPING_SIGNAL_MIN_INTERVAL_MS
};
