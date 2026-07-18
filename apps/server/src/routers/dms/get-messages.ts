import type { TFile, TJoinedDmMessage, TMessageReplyPreview } from '@pulse/shared';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  attachDmFileTokens,
  getDmChannelMemberIds,
  getReactionsForDmMessageIds
} from '../../db/queries/dms';
import { dmMessageFiles, dmMessages, dmReadStates, files } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const DEFAULT_DM_MESSAGES_LIMIT = 50;

const getMessagesRoute = protectedProcedure
  .input(
    z.object({
      dmChannelId: z.number(),
      cursor: z.number().nullish(),
      limit: z.number().default(DEFAULT_DM_MESSAGES_LIMIT)
    })
  )
  .query(async ({ ctx, input }) => {
    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this DM channel'
    });

    const { dmChannelId, cursor, limit } = input;

    const rows = await db
      .select()
      .from(dmMessages)
      .where(
        cursor
          ? and(
              eq(dmMessages.dmChannelId, dmChannelId),
              lt(dmMessages.createdAt, cursor)
            )
          : eq(dmMessages.dmChannelId, dmChannelId)
      )
      .orderBy(desc(dmMessages.createdAt))
      .limit(limit + 1);

    let nextCursor: number | null = null;

    if (rows.length > limit) {
      // Cursor = createdAt of the last RETURNED row: pointing at the
      // popped probe row made the next page's strict lt() skip it — one
      // message silently lost at every page boundary (same fix as the
      // channel messages route).
      rows.pop();
      nextCursor = rows[rows.length - 1]?.createdAt ?? null;
    }

    if (rows.length === 0) {
      return { messages: [], nextCursor };
    }

    const messageIds = rows.map((m) => m.id);

    const [fileRows, reactionsByMessage] = await Promise.all([
      db
        .select({
          dmMessageId: dmMessageFiles.dmMessageId,
          file: files
        })
        .from(dmMessageFiles)
        .innerJoin(files, eq(dmMessageFiles.fileId, files.id))
        .where(inArray(dmMessageFiles.dmMessageId, messageIds)),
      getReactionsForDmMessageIds(messageIds)
    ]);

    const filesByMessage = fileRows.reduce<Record<number, TFile[]>>(
      (acc, row) => {
        if (!acc[row.dmMessageId]) {
          acc[row.dmMessageId] = [];
        }
        acc[row.dmMessageId]!.push(row.file);
        return acc;
      },
      {}
    );

    // Fetch reply-to previews
    const replyToIds = rows
      .map((m) => m.replyToId)
      .filter((id): id is number => id != null);

    let replyToMap: Record<number, TMessageReplyPreview> = {};

    if (replyToIds.length > 0) {
      const replyRows = await db
        .select({
          id: dmMessages.id,
          content: dmMessages.content,
          userId: dmMessages.userId,
          e2ee: dmMessages.e2ee
        })
        .from(dmMessages)
        .where(inArray(dmMessages.id, replyToIds));

      const fileRowsForReplies = await db
        .select({ dmMessageId: dmMessageFiles.dmMessageId })
        .from(dmMessageFiles)
        .where(inArray(dmMessageFiles.dmMessageId, replyToIds));
      const repliesWithFiles = new Set(
        fileRowsForReplies.map((r) => r.dmMessageId)
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

    const messagesWithFiles: TJoinedDmMessage[] = rows.map((msg) => ({
      ...msg,
      files: attachDmFileTokens(filesByMessage[msg.id] ?? [], dmChannelId),
      reactions: reactionsByMessage[msg.id] ?? [],
      replyTo: msg.replyToId ? (replyToMap[msg.replyToId] ?? null) : null
    }));

    // Update read state
    const latestMessage = rows[0];

    if (latestMessage) {
      await db
        .insert(dmReadStates)
        .values({
          dmChannelId,
          userId: ctx.userId,
          lastReadMessageId: latestMessage.id,
          lastReadAt: Date.now()
        })
        .onConflictDoUpdate({
          target: [dmReadStates.userId, dmReadStates.dmChannelId],
          set: {
            lastReadMessageId: latestMessage.id,
            lastReadAt: Date.now()
          }
        });
    }

    return { messages: messagesWithFiles, nextCursor };
  });

export { getMessagesRoute };
