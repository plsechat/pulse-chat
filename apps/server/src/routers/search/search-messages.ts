import {
  ChannelPermission,
  type TFile,
  type TJoinedMessage,
  type TMessage,
  type TMessageReplyPreview
} from '@pulse/shared';
import {
  and,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  lt,
  sql,
  type SQL
} from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getReactionsForMessageIds } from '../../db/queries/messages';
import { channels, files, messageFiles, messages } from '../../db/schema';
import { generateFileToken } from '../../helpers/files-crypto';
import { serverProcedure } from '../../utils/procedures';

const searchMessagesRoute = serverProcedure()
  .input(
    z.object({
      query: z.string().min(1).max(200),
      channelId: z.number().int().positive().optional(),
      userId: z.number().int().positive().optional(),
      hasFile: z.boolean().optional(),
      hasLink: z.boolean().optional(),
      before: z.number().int().optional(),
      after: z.number().int().optional(),
      cursor: z.number().int().optional(),
      limit: z.number().int().min(1).max(50).default(25)
    })
  )
  .query(async ({ ctx, input }) => {
    const escapedQuery = input.query.replace(/[%_\\]/g, '\\$&');
    const conditions: SQL[] = [
      ilike(messages.content, `%${escapedQuery}%`),
      eq(messages.e2ee, false)
    ];

    // The channel set the caller may read. Every later step (rows, file
    // tokens, reply previews) is restricted to it — a server-wide search
    // must not surface private channels the caller has no VIEW on.
    let visibleChannelIds: number[];

    if (input.channelId) {
      await ctx.needsChannelPermission(
        input.channelId,
        ChannelPermission.VIEW_CHANNEL
      );
      visibleChannelIds = [input.channelId];
    } else {
      const serverChannelRows = await db
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.serverId, ctx.activeServerId));

      // Sequential on purpose: the per-connection permission cache is
      // lazily filled by the first call, so a parallel burst would load
      // it once per channel.
      visibleChannelIds = [];
      for (const { id } of serverChannelRows) {
        if (
          await ctx.hasChannelPermission(id, ChannelPermission.VIEW_CHANNEL)
        ) {
          visibleChannelIds.push(id);
        }
      }

      if (visibleChannelIds.length === 0) {
        return { messages: [], nextCursor: null };
      }
    }

    conditions.push(inArray(messages.channelId, visibleChannelIds));

    if (input.userId) {
      conditions.push(eq(messages.userId, input.userId));
    }

    if (input.hasLink) {
      conditions.push(ilike(messages.content, '%http%'));
    }

    if (input.hasFile) {
      // A correlated EXISTS keeps the result one row per message and the
      // ORDER BY free — the previous DISTINCT ON + ORDER BY createdAt
      // pair is rejected by Postgres outright.
      conditions.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(messageFiles)
            .where(eq(messageFiles.messageId, messages.id))
        )
      );
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

    const rows: TMessage[] = await db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
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
    const channelIds = [...new Set(rows.map((m) => m.channelId))];

    const [fileRows, reactionsByMessage, channelRows] = await Promise.all([
      db
        .select({
          messageId: messageFiles.messageId,
          file: files
        })
        .from(messageFiles)
        .innerJoin(files, eq(messageFiles.fileId, files.id))
        .where(inArray(messageFiles.messageId, messageIds)),
      getReactionsForMessageIds(messageIds),
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
    const channelByMessage = new Map(rows.map((m) => [m.id, m.channelId]));

    const filesByMessage = fileRows.reduce<Record<number, TFile[]>>(
      (acc, row) => {
        if (!acc[row.messageId]) {
          acc[row.messageId] = [];
        }

        const channelId = channelByMessage.get(row.messageId);
        const channel =
          channelId !== undefined ? channelMap.get(channelId) : undefined;
        const rowCopy: TFile = { ...row.file };

        // Only channels the caller can view reached this point, so a
        // token is only ever minted for an attachment they may open.
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
        // outside the channels the caller can read.
        .where(
          and(
            inArray(messages.id, replyToIds),
            inArray(messages.channelId, channelIds)
          )
        );

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
