import { ChannelPermission, ServerEvents, TYPING_MS } from '@pulse/shared';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { channelProcedure } from '../../utils/procedures';

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

// Scoped to the active server (a channel elsewhere reads as nonexistent,
// so the fan-out can't be pointed at other servers' viewer sets) and
// refused in preview: previewers are invisible to members.
const signalTypingRoute = channelProcedure(ChannelPermission.SEND_MESSAGES, {
  preview: 'refuse'
}).mutation(async ({ input, ctx }) => {
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
