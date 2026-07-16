import {
  ChannelPermission,
  ChannelType,
  DEFAULT_MESSAGES_LIMIT,
  ServerEvents,
  type TFile,
  type TJoinedMessage,
  type TJoinedMessageReaction,
  type TMessage,
  type TMessageReplyPreview
} from '@pulse/shared';
import { and, asc, desc, eq, gt, inArray, lt, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  getChannelsReadStatesForUser,
  getForumUnreadForUser
} from '../../db/queries/channels';
import { getServerUnreadCount } from '../../db/queries/servers';
import {
  channelReadStates,
  channels,
  files,
  messageFiles,
  messageReactions,
  messages
} from '../../db/schema';
import { generateFileToken } from '../../helpers/files-crypto';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const getMessagesRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      cursor: z.number().nullish(),
      // Jump-to-message support: `aroundId` returns a window of messages
      // centered on that message id; `after` pages FORWARD (ascending)
      // from a createdAt cursor to fill the gap below an around-window.
      // Mutually exclusive with `cursor`; aroundId wins if both given.
      aroundId: z.number().nullish(),
      after: z.number().nullish(),
      limit: z.number().default(DEFAULT_MESSAGES_LIMIT)
    })
  )
  .meta({ infinite: true })
  .query(async ({ ctx, input }) => {
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    const { channelId, cursor, limit } = input;

    const [channel] = await db
      .select({
        private: channels.private,
        fileAccessToken: channels.fileAccessToken
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    let rows: TMessage[];
    let nextCursor: number | null = null;
    // Non-null when newer messages than the returned window exist — pass
    // back as `after` to page toward the present. null = window reaches
    // the live tail.
    let afterCursor: number | null = null;

    if (input.aroundId != null) {
      const [anchor] = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.id, input.aroundId),
            eq(messages.channelId, channelId)
          )
        )
        .limit(1);

      invariant(anchor, {
        code: 'NOT_FOUND',
        message: 'Message not found'
      });

      // Half the window on each side of the anchor. `lte` includes the
      // anchor itself (and any equal-timestamp siblings) on the old side.
      const half = Math.max(1, Math.floor(limit / 2));
      const [olderRows, newerRows] = await Promise.all([
        db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.channelId, channelId),
              lte(messages.createdAt, anchor.createdAt)
            )
          )
          .orderBy(desc(messages.createdAt))
          .limit(half + 1),
        db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.channelId, channelId),
              gt(messages.createdAt, anchor.createdAt)
            )
          )
          .orderBy(asc(messages.createdAt))
          .limit(half + 1)
      ]);

      if (olderRows.length > half) {
        // The (half+1)th row only proves more history exists — it is NOT
        // returned, so the cursor must point at the last row we DO
        // return: the next page's strict lt() starts exactly at the
        // dropped row. Using the dropped row's createdAt instead loses
        // one message at every page boundary.
        olderRows.pop();
        nextCursor = olderRows[olderRows.length - 1]?.createdAt ?? null;
      }

      let hasNewer = false;
      if (newerRows.length > half) {
        newerRows.pop();
        hasNewer = true;
      }

      // Keep the response newest-first like the cursor pages.
      rows = [...newerRows.reverse(), ...olderRows];
      afterCursor = hasNewer && rows.length > 0 ? rows[0]!.createdAt : null;
    } else if (input.after != null) {
      const newerRows: TMessage[] = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            gt(messages.createdAt, input.after)
          )
        )
        .orderBy(asc(messages.createdAt))
        .limit(limit + 1);

      let hasNewer = false;
      if (newerRows.length > limit) {
        newerRows.pop();
        hasNewer = true;
      }

      rows = newerRows.reverse();
      afterCursor = hasNewer && rows.length > 0 ? rows[0]!.createdAt : null;
    } else {
      rows = await db
        .select()
        .from(messages)
        .where(
          cursor
            ? and(
                eq(messages.channelId, channelId),
                lt(messages.createdAt, cursor)
              )
            : eq(messages.channelId, channelId)
        )
        .orderBy(desc(messages.createdAt))
        .limit(limit + 1);

      if (rows.length > limit) {
        // Cursor = createdAt of the last RETURNED row (see the around
        // branch): pointing at the popped probe row instead made the
        // next page's strict lt() skip it — one message silently lost
        // at every page boundary while scrolling up.
        rows.pop();
        nextCursor = rows[rows.length - 1]?.createdAt ?? null;
      }
    }

    if (rows.length === 0) {
      return { messages: [], nextCursor, afterCursor };
    }

    const messageIds = rows.map((m) => m.id);

    const [fileRows, reactionRows] = await Promise.all([
      db
        .select({
          messageId: messageFiles.messageId,
          file: files
        })
        .from(messageFiles)
        .innerJoin(files, eq(messageFiles.fileId, files.id))
        .where(inArray(messageFiles.messageId, messageIds)),
      db
        .select({
          messageId: messageReactions.messageId,
          userId: messageReactions.userId,
          emoji: messageReactions.emoji,
          createdAt: messageReactions.createdAt,
          fileId: messageReactions.fileId,
          file: files
        })
        .from(messageReactions)
        .leftJoin(files, eq(messageReactions.fileId, files.id))
        .where(inArray(messageReactions.messageId, messageIds))
    ]);

    const filesByMessage = fileRows.reduce<Record<number, TFile[]>>(
      (acc, row) => {
        if (!acc[row.messageId]) {
          acc[row.messageId] = [];
        }

        const rowCopy: TFile = { ...row.file };

        if (channel.private) {
          // when a channel is private, we need to generate access tokens for each file
          // this allows files to be accessed only by users who have access to the channel
          // however, if a user decides to share the file link, they can do so and anyone with the link can access it
          // this is by design
          // the access token is generated using the channel's file access token
          // so if an admin wants to invalidate all file links, they can simply regenerate the channel's file access token

          rowCopy._accessToken = generateFileToken(
            row.file.id,
            channel.fileAccessToken
          );
        }

        acc[row.messageId]!.push(rowCopy);

        return acc;
      },
      {}
    );

    const reactionsByMessage = reactionRows.reduce<
      Record<number, TJoinedMessageReaction[]>
    >((acc, r) => {
      const reaction: TJoinedMessageReaction = {
        messageId: r.messageId,
        userId: r.userId,
        emoji: r.emoji,
        createdAt: r.createdAt,
        fileId: r.fileId,
        file: r.file
      };

      if (!acc[r.messageId]) {
        acc[r.messageId] = [];
      }

      acc[r.messageId]!.push(reaction);

      return acc;
    }, {});

    // Fetch reply-to previews
    const replyToIds = rows
      .map((m) => m.replyToId)
      .filter((id): id is number => id != null);

    let replyToMap: Record<number, TMessageReplyPreview> = {};

    if (replyToIds.length > 0) {
      const replyRows = await db
        .select({
          id: messages.id,
          content: messages.content,
          userId: messages.userId,
          e2ee: messages.e2ee
        })
        .from(messages)
        .where(inArray(messages.id, replyToIds));

      // Probe attachments per replied-to message so file-only messages
      // (content null + attachments present) don't render as "Message
      // deleted" in the reply preview.
      const fileRowsForReplies = await db
        .select({ messageId: messageFiles.messageId })
        .from(messageFiles)
        .where(inArray(messageFiles.messageId, replyToIds));
      const repliesWithFiles = new Set(
        fileRowsForReplies.map((r) => r.messageId)
      );

      replyToMap = replyRows.reduce<Record<number, TMessageReplyPreview>>(
        (acc, r) => {
          acc[r.id] = {
            id: r.id,
            content: r.content,
            userId: r.userId,
            hasFiles: repliesWithFiles.has(r.id),
            e2ee: r.e2ee
          };
          return acc;
        },
        {}
      );
    }

    // Combine messages with files, reactions, and reply previews
    const messagesWithFiles: TJoinedMessage[] = rows.map((msg) => ({
      ...msg,
      files: filesByMessage[msg.id] ?? [],
      reactions: reactionsByMessage[msg.id] ?? [],
      replyTo: msg.replyToId ? (replyToMap[msg.replyToId] ?? null) : null
    }));

    // Mark read on the INITIAL load only — NOT when paging history
    // (cursor/around/after). The old code force-marked read to the
    // absolute latest on EVERY fetch, so paging up through history erased
    // your unread state and wiped the "New messages" divider anchor. The
    // initial load still creates/advances the read-state row (so opening a
    // channel clears its badge and a never-read channel gets a row), but
    // to the newest message in THIS batch, not a re-query of the absolute
    // latest. The client-side divider survives because it reads the
    // connect-time snapshot, which this in-session update doesn't touch.
    const isInitialLoad =
      cursor == null && input.aroundId == null && input.after == null;
    const latestMessage = isInitialLoad ? rows[0] : undefined;

    if (latestMessage) {
      await db
        .insert(channelReadStates)
        .values({
          channelId,
          userId: ctx.userId,
          lastReadMessageId: latestMessage.id,
          lastReadAt: Date.now()
        })
        .onConflictDoUpdate({
          target: [channelReadStates.channelId, channelReadStates.userId],
          set: {
            lastReadMessageId: latestMessage.id,
            lastReadAt: Date.now()
          }
        });

      const { readStates, mentionStates } = await getChannelsReadStatesForUser(
        ctx.userId,
        channelId
      );

      pubsub.publishFor(ctx.userId, ServerEvents.CHANNEL_READ_STATES_UPDATE, {
        channelId,
        count: readStates[channelId] ?? 0,
        mentionCount: mentionStates[channelId] ?? 0
      });

      // Reading messages is the most common read path, but it only
      // republished the fetched channel's own count — the server-rail
      // badge and a forum parent's aggregate kept their stale values
      // until a full refresh. Mirror the recompute block from
      // channels/mark-as-read so every read path converges.
      const [channelInfo] = await db
        .select({
          serverId: channels.serverId,
          type: channels.type,
          parentChannelId: channels.parentChannelId
        })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1);

      if (channelInfo) {
        const { unreadCount: serverCount, mentionCount: serverMentionCount } =
          await getServerUnreadCount(ctx.userId, channelInfo.serverId);
        pubsub.publishFor(ctx.userId, ServerEvents.SERVER_UNREAD_COUNT_UPDATE, {
          serverId: channelInfo.serverId,
          count: serverCount,
          mentionCount: serverMentionCount
        });

        if (
          channelInfo.type === ChannelType.THREAD &&
          channelInfo.parentChannelId
        ) {
          const [parentInfo] = await db
            .select({ type: channels.type })
            .from(channels)
            .where(eq(channels.id, channelInfo.parentChannelId))
            .limit(1);

          if (parentInfo?.type === ChannelType.FORUM) {
            const { unreadCount, mentionCount } = await getForumUnreadForUser(
              ctx.userId,
              channelInfo.parentChannelId
            );
            pubsub.publishFor(
              ctx.userId,
              ServerEvents.CHANNEL_READ_STATES_UPDATE,
              {
                channelId: channelInfo.parentChannelId,
                count: unreadCount,
                mentionCount
              }
            );
          }
        }
      }
    }

    return { messages: messagesWithFiles, nextCursor, afterCursor };
  });

export { getMessagesRoute };
