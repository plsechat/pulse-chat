import type {
  TFile,
  TJoinedDmMessage,
  TMessageReplyPreview
} from '../../types';
import {
  and,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  lt,
  sql,
  type SQL
} from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  getDmChannelMemberIds,
  getReactionsForDmMessageIds
} from '../../db/queries/dms';
import { dmChannelMembers, dmMessageFiles, dmMessages, files } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const searchDmMessagesRoute = protectedProcedure
  .input(
    z.object({
      query: z.string().min(1).max(200),
      dmChannelId: z.number().int().positive().optional(),
      userId: z.number().int().positive().optional(),
      hasFile: z.boolean().optional(),
      cursor: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).default(25)
    })
  )
  .query(async ({ ctx, input }) => {
    const escapedQuery = input.query.replace(/[%_\\]/g, '\\$&');
    const conditions: SQL[] = [
      ilike(dmMessages.content, `%${escapedQuery}%`),
      eq(dmMessages.e2ee, false)
    ];

    // Every row (and every reply preview) stays inside this set.
    let channelScope: SQL;

    if (input.dmChannelId) {
      const memberIds = await getDmChannelMemberIds(input.dmChannelId);

      invariant(memberIds.includes(ctx.userId), {
        code: 'FORBIDDEN',
        message: 'You are not a member of this DM channel'
      });

      channelScope = eq(dmMessages.dmChannelId, input.dmChannelId);
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

      channelScope = inArray(dmMessages.dmChannelId, channelIds);
    }

    conditions.push(channelScope);

    if (input.userId) {
      conditions.push(eq(dmMessages.userId, input.userId));
    }

    if (input.cursor) {
      conditions.push(lt(dmMessages.createdAt, input.cursor));
    }

    // EXISTS instead of join + DISTINCT ON: Postgres requires DISTINCT
    // ON expressions to lead the ORDER BY, and we order by createdAt —
    // the old shape threw on every "has file" search.
    if (input.hasFile) {
      conditions.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(dmMessageFiles)
            .where(eq(dmMessageFiles.dmMessageId, dmMessages.id))
        )
      );
    }

    const { limit } = input;

    const rows = await db
      .select()
      .from(dmMessages)
      .where(and(...conditions))
      .orderBy(desc(dmMessages.createdAt))
      .limit(limit + 1);

    let nextCursor: number | null = null;

    if (rows.length > limit) {
      const next = rows.pop();
      nextCursor = next ? next.createdAt : null;
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
        .where(and(inArray(dmMessages.id, replyToIds), channelScope));

      replyToMap = replyRows.reduce<Record<number, TMessageReplyPreview>>(
        (acc, r) => {
          acc[r.id] = {
            id: r.id,
            content: r.content,
            userId: r.userId,
            e2ee: r.e2ee
          };
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
