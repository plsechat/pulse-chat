import type { TFile, TJoinedDmMessage, TJoinedDmMessageReaction, TMessageReplyPreview } from '@pulse/shared';
import { and, desc, eq, ilike, inArray, lt, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmChannelMembers, dmMessageFiles, dmMessageReactions, dmMessages, files } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const searchDmMessagesRoute = protectedProcedure
  .input(
    z.object({
      query: z.string().min(1).max(200),
      dmChannelId: z.number().optional(),
      userId: z.number().optional(),
      hasFile: z.boolean().optional(),
      cursor: z.number().optional(),
      limit: z.number().min(1).max(50).default(25)
    })
  )
  .query(async ({ ctx, input }) => {
    const escapedQuery = input.query.replace(/[%_\\]/g, '\\$&');
    const conditions: SQL[] = [
      ilike(dmMessages.content, `%${escapedQuery}%`)
    ];

    if (input.dmChannelId) {
      const memberIds = await getDmChannelMemberIds(input.dmChannelId);

      invariant(memberIds.includes(ctx.userId), {
        code: 'FORBIDDEN',
        message: 'You are not a member of this DM channel'
      });

      conditions.push(eq(dmMessages.dmChannelId, input.dmChannelId));
    } else {
      // Search across all user's DM channels
      const memberRows = await db
        .select({ dmChannelId: dmChannelMembers.dmChannelId })
        .from(dmChannelMembers)
        .where(eq(dmChannelMembers.userId, ctx.userId));

      const channelIds = memberRows.map((r) => r.dmChannelId);

      if (channelIds.length === 0) {
        return { messages: [], nextCursor: null };
      }

      conditions.push(inArray(dmMessages.dmChannelId, channelIds));
    }

    if (input.userId) {
      conditions.push(eq(dmMessages.userId, input.userId));
    }

    if (input.cursor) {
      conditions.push(lt(dmMessages.createdAt, input.cursor));
    }

    const { limit } = input;

    let rows;

    if (input.hasFile) {
      const results = await db
        .selectDistinctOn([dmMessages.id], { message: dmMessages })
        .from(dmMessages)
        .innerJoin(dmMessageFiles, eq(dmMessageFiles.dmMessageId, dmMessages.id))
        .where(and(...conditions))
        .orderBy(desc(dmMessages.createdAt))
        .limit(limit + 1);

      rows = results.map((r) => r.message);
    } else {
      rows = await db
        .select()
        .from(dmMessages)
        .where(and(...conditions))
        .orderBy(desc(dmMessages.createdAt))
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

    const [fileRows, reactionRows] = await Promise.all([
      db
        .select({
          dmMessageId: dmMessageFiles.dmMessageId,
          file: files
        })
        .from(dmMessageFiles)
        .innerJoin(files, eq(dmMessageFiles.fileId, files.id))
        .where(inArray(dmMessageFiles.dmMessageId, messageIds)),
      db
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
        .where(inArray(dmMessageReactions.dmMessageId, messageIds))
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

    const reactionsByMessage = reactionRows.reduce<
      Record<number, TJoinedDmMessageReaction[]>
    >((acc, r) => {
      if (!acc[r.dmMessageId]) {
        acc[r.dmMessageId] = [];
      }
      acc[r.dmMessageId]!.push({
        dmMessageId: r.dmMessageId,
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
          id: dmMessages.id,
          content: dmMessages.content,
          userId: dmMessages.userId
        })
        .from(dmMessages)
        .where(inArray(dmMessages.id, replyToIds));

      replyToMap = replyRows.reduce<Record<number, TMessageReplyPreview>>(
        (acc, r) => {
          acc[r.id] = { id: r.id, content: r.content, userId: r.userId };
          return acc;
        },
        {}
      );
    }

    const searchResults: TJoinedDmMessage[] = rows.map((msg) => ({
      ...msg,
      files: filesByMessage[msg.id] ?? [],
      reactions: reactionsByMessage[msg.id] ?? [],
      replyTo: msg.replyToId ? (replyToMap[msg.replyToId] ?? null) : null
    }));

    return { messages: searchResults, nextCursor };
  });

export { searchDmMessagesRoute };
