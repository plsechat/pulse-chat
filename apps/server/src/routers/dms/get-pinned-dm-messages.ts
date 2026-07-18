import type { TFile, TJoinedDmMessage, TMessageReplyPreview } from '@pulse/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  attachDmFileTokens,
  getDmChannelMemberIds,
  getReactionsForDmMessageIds
} from '../../db/queries/dms';
import { dmMessageFiles, dmMessages, files } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getPinnedDmMessagesRoute = protectedProcedure
  .input(
    z.object({
      dmChannelId: z.number()
    })
  )
  .query(async ({ ctx, input }) => {
    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this DM channel'
    });

    const rows = await db
      .select()
      .from(dmMessages)
      .where(
        and(
          eq(dmMessages.dmChannelId, input.dmChannelId),
          eq(dmMessages.pinned, true)
        )
      )
      .orderBy(desc(dmMessages.pinnedAt));

    if (rows.length === 0) {
      return [];
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

    const pinnedMessages: TJoinedDmMessage[] = rows.map((msg) => ({
      ...msg,
      files: attachDmFileTokens(
        filesByMessage[msg.id] ?? [],
        input.dmChannelId
      ),
      reactions: reactionsByMessage[msg.id] ?? [],
      replyTo: msg.replyToId ? (replyToMap[msg.replyToId] ?? null) : null
    }));

    return pinnedMessages;
  });

export { getPinnedDmMessagesRoute };
