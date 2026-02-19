import {
  ChannelPermission,
  type TFile,
  type TJoinedMessage,
  type TJoinedMessageReaction,
  type TMessage,
  type TMessageReplyPreview
} from '@pulse/shared';
import { and, desc, eq, gt, ilike, inArray, lt, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  channels,
  files,
  messageFiles,
  messageReactions,
  messages
} from '../../db/schema';
import { generateFileToken } from '../../helpers/files-crypto';
import { protectedProcedure } from '../../utils/trpc';

const searchMessagesRoute = protectedProcedure
  .input(
    z.object({
      query: z.string().min(1).max(200),
      channelId: z.number().optional(),
      userId: z.number().optional(),
      hasFile: z.boolean().optional(),
      hasLink: z.boolean().optional(),
      before: z.number().optional(),
      after: z.number().optional(),
      cursor: z.number().optional(),
      limit: z.number().min(1).max(50).default(25)
    })
  )
  .query(async ({ ctx, input }) => {
    const escapedQuery = input.query.replace(/[%_\\]/g, '\\$&');
    const conditions: SQL[] = [
      ilike(messages.content, `%${escapedQuery}%`),
      eq(messages.e2ee, false)
    ];

    if (input.channelId) {
      await ctx.needsChannelPermission(
        input.channelId,
        ChannelPermission.VIEW_CHANNEL
      );
      conditions.push(eq(messages.channelId, input.channelId));
    }

    if (input.userId) {
      conditions.push(eq(messages.userId, input.userId));
    }

    if (input.hasLink) {
      conditions.push(ilike(messages.content, '%http%'));
    }

    if (input.before) {
      conditions.push(lt(messages.createdAt, input.before));
    }

    if (input.after) {
      conditions.push(gt(messages.createdAt, input.after));
    }

    if (input.cursor) {
      conditions.push(lt(messages.createdAt, input.cursor));
    }

    const { limit } = input;

    let rows: TMessage[];

    if (input.hasFile) {
      // Join with messageFiles to filter messages that have attachments
      const results = await db
        .selectDistinctOn([messages.id], { message: messages })
        .from(messages)
        .innerJoin(messageFiles, eq(messageFiles.messageId, messages.id))
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt))
        .limit(limit + 1);

      rows = results.map((r) => r.message);
    } else {
      rows = await db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt))
        .limit(limit + 1);
    }

    let nextCursor: number | null = null;

    if (rows.length > limit) {
      const next = rows.pop();
      nextCursor = next ? next.createdAt : null;
    }

    if (rows.length === 0) {
      return { messages: [], nextCursor };
    }

    const messageIds = rows.map((m) => m.id);
    const channelIds = [...new Set(rows.map((m) => m.channelId))];

    const [fileRows, reactionRows, channelRows] = await Promise.all([
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
        .where(inArray(messageReactions.messageId, messageIds)),
      db
        .select({
          id: channels.id,
          private: channels.private,
          fileAccessToken: channels.fileAccessToken
        })
        .from(channels)
        .where(inArray(channels.id, channelIds))
    ]);

    const channelMap = new Map(channelRows.map((c) => [c.id, c]));

    const filesByMessage = fileRows.reduce<Record<number, TFile[]>>(
      (acc, row) => {
        if (!acc[row.messageId]) {
          acc[row.messageId] = [];
        }

        const msg = rows.find((m) => m.id === row.messageId);
        const channel = msg ? channelMap.get(msg.channelId) : undefined;
        const rowCopy: TFile = { ...row.file };

        if (channel?.private) {
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
      if (!acc[r.messageId]) {
        acc[r.messageId] = [];
      }

      acc[r.messageId]!.push({
        messageId: r.messageId,
        userId: r.userId,
        emoji: r.emoji,
        createdAt: r.createdAt,
        fileId: r.fileId,
        file: r.file
      });

      return acc;
    }, {});

    const replyToIds = rows
      .map((m) => m.replyToId)
      .filter((id): id is number => id != null);

    let replyToMap: Record<number, TMessageReplyPreview> = {};

    if (replyToIds.length > 0) {
      const replyRows = await db
        .select({
          id: messages.id,
          content: messages.content,
          userId: messages.userId
        })
        .from(messages)
        .where(inArray(messages.id, replyToIds));

      replyToMap = replyRows.reduce<Record<number, TMessageReplyPreview>>(
        (acc, r) => {
          acc[r.id] = { id: r.id, content: r.content, userId: r.userId };
          return acc;
        },
        {}
      );
    }

    const searchResults: TJoinedMessage[] = rows.map((msg) => ({
      ...msg,
      files: filesByMessage[msg.id] ?? [],
      reactions: reactionsByMessage[msg.id] ?? [],
      replyTo: msg.replyToId ? (replyToMap[msg.replyToId] ?? null) : null
    }));

    return { messages: searchResults, nextCursor };
  });

export { searchMessagesRoute };
