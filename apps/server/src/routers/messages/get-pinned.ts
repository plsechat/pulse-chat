import { ChannelPermission } from '@pulse/shared';
import type {
  TFile,
  TJoinedMessage,
  TMessage,
  TMessageReplyPreview
} from '../../types';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { getReactionsForMessageIds } from '../../db/queries/messages';
import { files, messageFiles, messages } from '../../db/schema';
import { generateFileToken } from '../../helpers/files-crypto';
import { channelProcedure } from '../../utils/procedures';

// Preview 'permit': pins are part of what a read-only preview may read.
const getPinnedMessagesRoute = channelProcedure(
  ChannelPermission.VIEW_CHANNEL,
  { preview: 'permit' }
).query(async ({ ctx, input }) => {
    const { channel } = ctx;

    const rows: TMessage[] = await db
      .select()
      .from(messages)
      .where(
        // Deletion clears the pin; the filter is belt and braces.
        and(
          eq(messages.channelId, input.channelId),
          eq(messages.pinned, true),
          isNull(messages.deletedAt)
        )
      )
      .orderBy(desc(messages.pinnedAt));

    if (rows.length === 0) {
      return [];
    }

    const messageIds = rows.map((m) => m.id);

    const [fileRows, reactionsByMessage] = await Promise.all([
      db
        .select({
          messageId: messageFiles.messageId,
          file: files
        })
        .from(messageFiles)
        .innerJoin(files, eq(messageFiles.fileId, files.id))
        .where(inArray(messageFiles.messageId, messageIds)),
      getReactionsForMessageIds(messageIds)
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
        // Replies are same-channel by construction (send validates it);
        // the condition keeps a stray id from ever previewing content
        // outside the channel the caller is reading.
        .where(
          and(
            inArray(messages.id, replyToIds),
            eq(messages.channelId, input.channelId)
          )
        );

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
            hasFiles: repliesWithFiles.has(r.id)
          };
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
