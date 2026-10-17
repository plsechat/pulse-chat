import { ChannelPermission, ServerEvents } from '@pulse/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '..';
import type { TPollUpdate, TPollView } from '../../types';
import { logger } from '../../logger';
import { pubsub } from '../../utils/pubsub';
import { channels, polls, pollVotes } from '../schema';
import { getAffectedUserIdsForChannel } from './channels';

/**
 * Voter ids shipped per option. The count is always exact; the id list
 * only feeds the "who voted" hover, and a channel-wide poll with
 * hundreds of voters would otherwise fan out a payload of that size on
 * every single vote.
 */
const POLL_VOTER_LIST_CAP = 50;

type TPollRow = typeof polls.$inferSelect;

/**
 * A poll with the channel it lives in, scoped to one server: a poll of
 * another server reads as "not found", never as a cross-server vote.
 */
const getPollInServer = async (
  pollId: number,
  serverId: number
): Promise<{ poll: TPollRow; channel: typeof channels.$inferSelect } | undefined> => {
  const [row] = await db
    .select({ poll: polls, channel: channels })
    .from(polls)
    .innerJoin(channels, eq(polls.channelId, channels.id))
    .where(and(eq(polls.id, pollId), eq(channels.serverId, serverId)))
    .limit(1);

  return row;
};

/** Same scope rule, addressed by the carrying message (the card's handle). */
const getPollByMessageInServers = async (
  messageId: number,
  serverIds: number[]
): Promise<{ poll: TPollRow; channel: typeof channels.$inferSelect } | undefined> => {
  if (serverIds.length === 0) return undefined;

  const [row] = await db
    .select({ poll: polls, channel: channels })
    .from(polls)
    .innerJoin(channels, eq(polls.channelId, channels.id))
    .where(
      and(eq(polls.messageId, messageId), inArray(channels.serverId, serverIds))
    )
    .limit(1);

  return row;
};

const buildPollUpdate = async (poll: TPollRow): Promise<TPollUpdate> => {
  const votes = await db
    .select({ userId: pollVotes.userId, optionKey: pollVotes.optionKey })
    .from(pollVotes)
    .where(eq(pollVotes.pollId, poll.id))
    .orderBy(pollVotes.id);

  const byOption = new Map<string, number[]>();
  const voters = new Set<number>();

  for (const vote of votes) {
    voters.add(vote.userId);
    const list = byOption.get(vote.optionKey) ?? [];
    list.push(vote.userId);
    byOption.set(vote.optionKey, list);
  }

  return {
    id: poll.id,
    messageId: poll.messageId,
    channelId: poll.channelId,
    question: poll.question,
    options: poll.options.map((option) => {
      const ids = byOption.get(option.key) ?? [];
      return {
        key: option.key,
        label: option.label,
        votes: ids.length,
        voterIds: poll.anonymous ? [] : ids.slice(0, POLL_VOTER_LIST_CAP)
      };
    }),
    multiple: poll.multiple,
    anonymous: poll.anonymous,
    closesAt: poll.closesAt,
    closedAt: poll.closedAt,
    createdBy: poll.createdBy,
    createdAt: poll.createdAt,
    totalVoters: voters.size
  };
};

const buildPollView = async (
  poll: TPollRow,
  viewerUserId: number
): Promise<TPollView> => {
  const [update, own] = await Promise.all([
    buildPollUpdate(poll),
    db
      .select({ optionKey: pollVotes.optionKey })
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, viewerUserId)))
  ]);

  return { ...update, ownVotes: own.map((v) => v.optionKey) };
};

/**
 * Fan the poll's counts out to everyone who can see its channel. Fire
 * and forget like publishMessage: a vote never fails because the
 * audience lookup did.
 */
const publishPollUpdate = async (poll: TPollRow): Promise<void> => {
  try {
    const [update, audience] = await Promise.all([
      buildPollUpdate(poll),
      getAffectedUserIdsForChannel(poll.channelId, {
        permission: ChannelPermission.VIEW_CHANNEL
      })
    ]);

    pubsub.publishFor(audience, ServerEvents.POLL_UPDATE, update);
  } catch (err) {
    logger.error('[polls] publish failed for poll %d: %o', poll.id, err);
  }
};

/** Closes the poll if still open; returns the row as it is afterwards. */
const closePoll = async (pollId: number, now: number): Promise<TPollRow | undefined> => {
  const [closed] = await db
    .update(polls)
    .set({ closedAt: now })
    .where(and(eq(polls.id, pollId), isNull(polls.closedAt)))
    .returning();

  if (closed) return closed;

  const [current] = await db.select().from(polls).where(eq(polls.id, pollId)).limit(1);
  return current;
};

export {
  buildPollUpdate,
  buildPollView,
  closePoll,
  getPollByMessageInServers,
  getPollInServer,
  publishPollUpdate
};
