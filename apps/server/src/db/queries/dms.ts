import type {
  TDmMessageReaction,
  TFile,
  TFileRef,
  TJoinedDmChannel,
  TJoinedDmMessage,
  TJoinedDmMessageReaction,
  TReactionUser
} from '@pulse/shared';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '..';
import { dmFileSalt, generateFileToken } from '../../helpers/files-crypto';
import {
  dmChannelMembers,
  dmChannels,
  dmMessageFiles,
  dmMessageReactions,
  dmMessages,
  dmReadStates,
  federationInstances,
  files,
  users
} from '../schema';
import { getPublicUsersByIds } from './users';

/** Slim a joined avatar file row to the ref the client needs for a URL. */
const toReactionAvatar = (file: TFile | null): TFileRef | null =>
  file?.id ? { id: file.id, name: file.name } : null;

/**
 * DM counterpart of getReactionsForMessageIds — each reaction carries the
 * reactor's name + avatar so the "who reacted" hover resolves correctly in
 * the home id-space (DM participants are never in the ambient server
 * roster). See TReactionUser.
 */
const getReactionsForDmMessageIds = async (
  messageIds: number[]
): Promise<Record<number, TJoinedDmMessageReaction[]>> => {
  if (messageIds.length === 0) return {};

  const reactorAvatar = alias(files, 'dmReactorAvatarFile');

  const rows = await db
    .select({
      dmMessageId: dmMessageReactions.dmMessageId,
      userId: dmMessageReactions.userId,
      emoji: dmMessageReactions.emoji,
      createdAt: dmMessageReactions.createdAt,
      fileId: dmMessageReactions.fileId,
      file: files,
      reactorName: users.name,
      reactorAvatar
    })
    .from(dmMessageReactions)
    .leftJoin(files, eq(dmMessageReactions.fileId, files.id))
    .leftJoin(users, eq(dmMessageReactions.userId, users.id))
    .leftJoin(reactorAvatar, eq(users.avatarId, reactorAvatar.id))
    .where(inArray(dmMessageReactions.dmMessageId, messageIds));

  return rows.reduce<Record<number, TJoinedDmMessageReaction[]>>((acc, r) => {
    // Null (not falsy) — users.name is notNull but '' passes it; an
    // empty-named user still has a matched join and a real identity.
    const user: TReactionUser | null =
      r.reactorName != null
        ? {
            id: r.userId,
            name: r.reactorName,
            avatar: toReactionAvatar(r.reactorAvatar)
          }
        : null;

    (acc[r.dmMessageId] ??= []).push({
      dmMessageId: r.dmMessageId,
      userId: r.userId,
      emoji: r.emoji,
      createdAt: r.createdAt,
      fileId: r.fileId,
      file: r.file,
      user
    });

    return acc;
  }, {});
};

/**
 * Attach the DM file access token to each file so an authorized member's
 * client includes it when fetching from the public route (getFileUrl
 * appends `?accessToken`). Without it the serve path now 403s DM
 * attachments. Mirrors the private-channel `_accessToken` pattern.
 */
const attachDmFileTokens = <T extends { id: number }>(
  fileList: T[],
  dmChannelId: number
): (T & { _accessToken: string })[] =>
  fileList.map((f) => ({
    ...f,
    _accessToken: generateFileToken(f.id, dmFileSalt(dmChannelId))
  }));

/**
 * Resolve the DM channel a file belongs to (via its DM message), or
 * undefined if the file isn't a DM attachment. Used by the public serve
 * route to gate DM files behind the DM token.
 */
const getDmChannelIdByFileId = async (
  fileId: number
): Promise<number | undefined> => {
  const [row] = await db
    .select({ dmChannelId: dmMessages.dmChannelId })
    .from(dmMessageFiles)
    .innerJoin(dmMessages, eq(dmMessages.id, dmMessageFiles.dmMessageId))
    .where(eq(dmMessageFiles.fileId, fileId))
    .limit(1);
  return row?.dmChannelId;
};

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

type TDmPairMember = {
  publicId: string;
  isFederated: boolean;
  federatedPublicId: string | null;
  instanceDomain: string | null;
};

/**
 * Stable identity of a DM participant for the pair key. A shadow is named
 * by its home instance and the publicId that home issued, which is how
 * both ends of a federated DM know it; a local user by our own publicId.
 * A legacy shadow that lacks either (minted before publicIds were
 * mandatory) falls back to its local publicId — unique on this instance,
 * which is all the key needs to be.
 */
const dmIdentityOf = (u: TDmPairMember): string =>
  u.isFederated && u.federatedPublicId && u.instanceDomain
    ? `federated:${u.instanceDomain}:${u.federatedPublicId}`
    : `local:${u.publicId}`;

/**
 * Canonical key of the 1:1 DM between two users: both identities sorted
 * by code unit (the migration backfill sorts with COLLATE "C" so the
 * two agree) and joined with '|'. The unique index on dm_channels.pair_key
 * is what stops two first messages crossing between instances from
 * minting two channels for one pair.
 */
const pairKeyFor = async (
  userIdA: number,
  userIdB: number
): Promise<string> => {
  if (userIdA === userIdB) {
    throw new Error('A DM pair needs two distinct users');
  }
  const rows = await db
    .select({
      publicId: users.publicId,
      isFederated: users.isFederated,
      federatedPublicId: users.federatedPublicId,
      instanceDomain: federationInstances.domain
    })
    .from(users)
    .leftJoin(
      federationInstances,
      eq(users.federatedInstanceId, federationInstances.id)
    )
    .where(inArray(users.id, [userIdA, userIdB]));
  if (rows.length !== 2) {
    throw new Error('A DM pair needs two existing users');
  }
  return rows
    .map(dmIdentityOf)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join('|');
};

/**
 * The 1:1 channel between two users, by pair key. A channel that predates
 * the key (NULL pair_key — a mirror minted by an older relay path, or a
 * database whose backfill was skipped) is found by its membership and
 * stamped on the way out, so the next lookup is the indexed one and a
 * concurrent creation cannot mint a second channel beside it.
 */
const findDmChannelBetween = async (
  userIdA: number,
  userIdB: number,
  pairKey?: string
): Promise<number | null> => {
  const key = pairKey ?? (await pairKeyFor(userIdA, userIdB));

  const [byKey] = await db
    .select({ id: dmChannels.id })
    .from(dmChannels)
    .where(eq(dmChannels.pairKey, key))
    .limit(1);
  if (byKey) return byKey.id;

  const [unstamped] = await db
    .select({ id: dmChannels.id })
    .from(dmChannels)
    .innerJoin(dmChannelMembers, eq(dmChannelMembers.dmChannelId, dmChannels.id))
    .where(and(eq(dmChannels.isGroup, false), isNull(dmChannels.pairKey)))
    .groupBy(dmChannels.id)
    .having(
      and(
        sql`count(*) = 2`,
        sql`bool_or(${dmChannelMembers.userId} = ${userIdA})`,
        sql`bool_or(${dmChannelMembers.userId} = ${userIdB})`
      )
    )
    .orderBy(dmChannels.id)
    .limit(1);
  if (!unstamped) return null;

  try {
    await db
      .update(dmChannels)
      .set({ pairKey: key })
      .where(and(eq(dmChannels.id, unstamped.id), isNull(dmChannels.pairKey)));
    return unstamped.id;
  } catch {
    // The key was taken between the two lookups — a creation for this
    // pair won the race. That row is now the canonical one.
    const [raced] = await db
      .select({ id: dmChannels.id })
      .from(dmChannels)
      .where(eq(dmChannels.pairKey, key))
      .limit(1);
    return raced?.id ?? unstamped.id;
  }
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

  const reactions =
    (await getReactionsForDmMessageIds([messageId]))[messageId] ?? [];

  let replyTo: TJoinedDmMessage['replyTo'] = null;

  if (msg.replyToId) {
    const [replyRow] = await db
      .select({
        id: dmMessages.id,
        content: dmMessages.content,
        userId: dmMessages.userId,
        e2ee: dmMessages.e2ee
      })
      .from(dmMessages)
      // Same conversation only — never preview another DM's text.
      .where(
        and(
          eq(dmMessages.id, msg.replyToId),
          eq(dmMessages.dmChannelId, msg.dmChannelId)
        )
      )
      .limit(1);

    if (replyRow) {
      const [hasFileRow] = await db
        .select({ dmMessageId: dmMessageFiles.dmMessageId })
        .from(dmMessageFiles)
        .where(eq(dmMessageFiles.dmMessageId, msg.replyToId))
        .limit(1);

      replyTo = {
        ...replyRow,
        hasFiles: !!hasFileRow
      };
    }
  }

  return {
    ...msg,
    files: attachDmFileTokens(
      fileRows.map((r) => r.file),
      msg.dmChannelId
    ),
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
  attachDmFileTokens,
  findDmChannelBetween,
  getDmChannelIdByFileId,
  getDmChannelMemberIds,
  getDmChannelsForUser,
  getDmMessage,
  getDmReaction,
  getReactionsForDmMessageIds,
  pairKeyFor
};
