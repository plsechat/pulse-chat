import type {
  TDmMessageReaction,
  TJoinedDmChannel,
  TJoinedDmMessage,
  TJoinedDmMessageReaction
} from '@pulse/shared';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '..';
import {
  dmChannelMembers,
  dmChannels,
  dmMessageFiles,
  dmMessageReactions,
  dmMessages,
  dmReadStates,
  files
} from '../schema';
import { getPublicUsersByIds } from './users';

const getDmChannelsForUser = async (
  userId: number
): Promise<TJoinedDmChannel[]> => {
  // Query 1: Get channel IDs the user belongs to
  const memberRows = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.userId, userId));

  const channelIds = memberRows.map((r) => r.dmChannelId);

  if (channelIds.length === 0) return [];

  // Query 2: Get channel data
  const channelRows = await db
    .select()
    .from(dmChannels)
    .where(inArray(dmChannels.id, channelIds));

  // Query 3: Batch-fetch all members for all channels
  const allMemberRows = await db
    .select({
      dmChannelId: dmChannelMembers.dmChannelId,
      userId: dmChannelMembers.userId
    })
    .from(dmChannelMembers)
    .where(inArray(dmChannelMembers.dmChannelId, channelIds));

  // Query 4: Batch-fetch all public users
  const uniqueUserIds = [...new Set(allMemberRows.map((r) => r.userId))];
  const usersMap = await getPublicUsersByIds(uniqueUserIds);

  // Query 5: Batch-fetch last messages using DISTINCT ON
  const lastMessages = await db
    .selectDistinctOn([dmMessages.dmChannelId])
    .from(dmMessages)
    .where(inArray(dmMessages.dmChannelId, channelIds))
    .orderBy(dmMessages.dmChannelId, desc(dmMessages.createdAt));

  const lastMsgMap = new Map(lastMessages.map((m) => [m.dmChannelId, m]));

  // Query 6: Batch-fetch read states
  const readStates = await db
    .select()
    .from(dmReadStates)
    .where(
      and(
        eq(dmReadStates.userId, userId),
        inArray(dmReadStates.dmChannelId, channelIds)
      )
    );

  const readStateMap = new Map(readStates.map((rs) => [rs.dmChannelId, rs]));

  // Query 7: Batch-fetch unread counts (only for channels with a read state)
  // Channels without a read state are treated as fully read (0 unread)
  const unreadCountMap = new Map<number, number>();

  const withReadState = channelIds.filter(
    (id) => readStateMap.get(id)?.lastReadMessageId
  );

  if (withReadState.length > 0) {
    const conditions = withReadState.map((chId) =>
      and(
        eq(dmMessages.dmChannelId, chId),
        sql`${dmMessages.id} > ${readStateMap.get(chId)!.lastReadMessageId}`
      )
    );
    const counts = await db
      .select({
        dmChannelId: dmMessages.dmChannelId,
        count: sql<number>`count(*)`
      })
      .from(dmMessages)
      .where(or(...conditions))
      .groupBy(dmMessages.dmChannelId);

    for (const c of counts) {
      unreadCountMap.set(c.dmChannelId, Number(c.count));
    }
  }

  // Group members by channel
  const membersByChannel = new Map<number, number[]>();
  for (const row of allMemberRows) {
    if (!membersByChannel.has(row.dmChannelId))
      membersByChannel.set(row.dmChannelId, []);
    membersByChannel.get(row.dmChannelId)!.push(row.userId);
  }

  // Assemble results
  const result: TJoinedDmChannel[] = channelRows.map((channel) => {
    const memberUserIds = membersByChannel.get(channel.id) ?? [];
    const members = memberUserIds
      .map((uid) => usersMap.get(uid))
      .filter((u) => u !== undefined);

    return {
      ...channel,
      members,
      lastMessage: lastMsgMap.get(channel.id) ?? null,
      unreadCount: unreadCountMap.get(channel.id) ?? 0
    };
  });

  // Sort by last message time (most recent first)
  result.sort((a, b) => {
    const aTime = a.lastMessage?.createdAt ?? a.createdAt;
    const bTime = b.lastMessage?.createdAt ?? b.createdAt;
    return bTime - aTime;
  });

  return result;
};

const findDmChannelBetween = async (
  userId1: number,
  userId2: number
): Promise<number | null> => {
  // Query 1: Get non-group DM channels for userId1
  const candidates = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .innerJoin(dmChannels, eq(dmChannels.id, dmChannelMembers.dmChannelId))
    .where(
      and(
        eq(dmChannelMembers.userId, userId1),
        eq(dmChannels.isGroup, false)
      )
    );

  if (candidates.length === 0) return null;

  const candidateIds = candidates.map((r) => r.dmChannelId);

  // Query 2: Find channels with exactly 2 members that include userId2
  const matches = await db
    .select({
      dmChannelId: dmChannelMembers.dmChannelId
    })
    .from(dmChannelMembers)
    .where(inArray(dmChannelMembers.dmChannelId, candidateIds))
    .groupBy(dmChannelMembers.dmChannelId)
    .having(
      and(
        sql`count(*) = 2`,
        sql`bool_or(${dmChannelMembers.userId} = ${userId2})`
      )
    );

  return matches[0]?.dmChannelId ?? null;
};

const getDmMessage = async (
  messageId: number
): Promise<TJoinedDmMessage | null> => {
  const [msg] = await db
    .select()
    .from(dmMessages)
    .where(eq(dmMessages.id, messageId))
    .limit(1);

  if (!msg) return null;

  const fileRows = await db
    .select({ file: files })
    .from(dmMessageFiles)
    .innerJoin(files, eq(dmMessageFiles.fileId, files.id))
    .where(eq(dmMessageFiles.dmMessageId, messageId));

  const reactionRows = await db
    .select({
      dmMessageId: dmMessageReactions.dmMessageId,
      userId: dmMessageReactions.userId,
      emoji: dmMessageReactions.emoji,
      createdAt: dmMessageReactions.createdAt,
      fileId: dmMessageReactions.fileId,
      file: files
    })
    .from(dmMessageReactions)
    .leftJoin(files, eq(dmMessageReactions.fileId, files.id))
    .where(eq(dmMessageReactions.dmMessageId, messageId));

  const reactions: TJoinedDmMessageReaction[] = reactionRows.map((r) => ({
    dmMessageId: r.dmMessageId,
    userId: r.userId,
    emoji: r.emoji,
    createdAt: r.createdAt,
    fileId: r.fileId,
    file: r.file
  }));

  let replyTo = null;

  if (msg.replyToId) {
    const [replyRow] = await db
      .select({
        id: dmMessages.id,
        content: dmMessages.content,
        userId: dmMessages.userId
      })
      .from(dmMessages)
      .where(eq(dmMessages.id, msg.replyToId))
      .limit(1);

    replyTo = replyRow ?? null;
  }

  return {
    ...msg,
    files: fileRows.map((r) => r.file),
    reactions,
    replyTo
  };
};

const getDmReaction = async (
  dmMessageId: number,
  emoji: string,
  userId: number
): Promise<TDmMessageReaction | undefined> => {
  const [reaction] = await db
    .select()
    .from(dmMessageReactions)
    .where(
      and(
        eq(dmMessageReactions.dmMessageId, dmMessageId),
        eq(dmMessageReactions.emoji, emoji),
        eq(dmMessageReactions.userId, userId)
      )
    )
    .limit(1);

  return reaction;
};

const getDmChannelMemberIds = async (
  dmChannelId: number
): Promise<number[]> => {
  const rows = await db
    .select({ userId: dmChannelMembers.userId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.dmChannelId, dmChannelId));

  return rows.map((r) => r.userId);
};

export {
  findDmChannelBetween,
  getDmChannelMemberIds,
  getDmChannelsForUser,
  getDmMessage,
  getDmReaction
};
