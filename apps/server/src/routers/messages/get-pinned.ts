import {
  ChannelPermission,
  type TFile,
  type TJoinedMessage,
  type TJoinedMessageReaction,
  type TMessage,
  type TMessageReplyPreview
} from '@pulse/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
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
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getPinnedMessagesRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number()
    })
  )
  .query(async ({ ctx, input }) => {
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    const [channel] = await db
      .select({
        private: channels.private,
        fileAccessToken: channels.fileAccessToken
      })
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: `Channel ${input.channelId} not found`
    });

    const rows: TMessage[] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.channelId, input.channelId),
          eq(messages.pinned, true)
        )
      )
      .orderBy(desc(messages.pinnedAt));

    if (rows.length === 0) {
      return [];
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

    const pinnedMessages: TJoinedMessage[] = rows.map((msg) => ({
      ...msg,
      files: filesByMessage[msg.id] ?? [],
      reactions: reactionsByMessage[msg.id] ?? [],
      replyTo: msg.replyToId ? (replyToMap[msg.replyToId] ?? null) : null
    }));

    return pinnedMessages;
  });

export { getPinnedMessagesRoute };
