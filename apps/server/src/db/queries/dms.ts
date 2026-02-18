import type {
  TDmMessageReaction,
  TJoinedDmChannel,
  TJoinedDmMessage,
  TJoinedDmMessageReaction
} from '@pulse/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
import { getPublicUserById } from './users';

const getDmChannelsForUser = async (
  userId: number
): Promise<TJoinedDmChannel[]> => {
  const memberRows = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.userId, userId));

  const channelIds = memberRows.map((r) => r.dmChannelId);

  if (channelIds.length === 0) return [];

  const channelRows = await db
    .select()
    .from(dmChannels)
    .where(inArray(dmChannels.id, channelIds));

  const result: TJoinedDmChannel[] = [];

  for (const channel of channelRows) {
    const members = await db
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, channel.id));

    const joinedMembers = [];

    for (const m of members) {
      const user = await getPublicUserById(m.userId);
      if (user) joinedMembers.push(user);
    }

    const [lastMsg] = await db
      .select()
      .from(dmMessages)
      .where(eq(dmMessages.dmChannelId, channel.id))
      .orderBy(desc(dmMessages.createdAt))
      .limit(1);

    const [readState] = await db
      .select()
      .from(dmReadStates)
      .where(
        and(
          eq(dmReadStates.userId, userId),
          eq(dmReadStates.dmChannelId, channel.id)
        )
      )
      .limit(1);

    let unreadCount = 0;

    if (readState?.lastReadMessageId) {
      const [countResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(dmMessages)
        .where(
          and(
            eq(dmMessages.dmChannelId, channel.id),
            sql`${dmMessages.id} > ${readState.lastReadMessageId}`
          )
        );
      unreadCount = Number(countResult?.count ?? 0);
    } else if (lastMsg) {
      const [countResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(dmMessages)
        .where(eq(dmMessages.dmChannelId, channel.id));
      unreadCount = Number(countResult?.count ?? 0);
    }

    result.push({
      ...channel,
      members: joinedMembers,
      lastMessage: lastMsg ?? null,
      unreadCount
    });
  }

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
  // Find DM channels that contain both users (1-on-1 only: not group, exactly 2 members)
  const rows = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.userId, userId1));

  for (const row of rows) {
    // Check that this channel is not a group DM
    const [channel] = await db
      .select({ isGroup: dmChannels.isGroup })
      .from(dmChannels)
      .where(eq(dmChannels.id, row.dmChannelId))
      .limit(1);

    if (channel?.isGroup) continue;

    const members = await db
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, row.dmChannelId));

    if (
      members.length === 2 &&
      members.some((m) => m.userId === userId2)
    ) {
      return row.dmChannelId;
    }
  }

  return null;
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
