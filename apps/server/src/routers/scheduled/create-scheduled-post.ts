import {
  ChannelPermission,
  ChannelType,
  MAX_MESSAGE_CONTENT_LENGTH,
  Permission
} from '@pulse/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishScheduledPostUpdate } from '../../db/queries/scheduled-posts';
import { scheduledPostFiles, scheduledPosts } from '../../db/schema';
import { assertCanPostInChannel } from '../../utils/announcement-gate';
import {
  assertNotTimedOut,
  checkAutomod,
  executeAutomodActions
} from '../../utils/automod';
import { fileManager } from '../../utils/file-manager';
import { invariant } from '../../utils/invariant';
import { channelProcedure } from '../../utils/procedures';

/** Same attachment bounds as a direct send. */
const MAX_FILES_PER_POST = 10;
const MAX_TEMP_FILE_ID_LENGTH = 64;
/** A post goes out no sooner than this … */
const MIN_SEND_LEAD_MS = 2 * 60 * 1000;
/** … and no later than this. */
const MAX_SEND_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Pending rows one author may hold on the instance. Each is a future
 * send with its own files on disk; a loop could otherwise fill the
 * table and the upload quota in one go.
 */
const MAX_PENDING_PER_USER = 50;

/**
 * Schedule a message for later. Everything the direct send verifies is
 * verified here (permissions, timeout, announcement rule, automod) so
 * the author gets the refusal now, not in a cron log; the sender cron
 * runs the same gates again at send time. Uploads are promoted to real
 * files right away and linked through scheduled_post_files so the
 * orphan scan keeps them until the post goes out.
 */
const createScheduledPostRoute = channelProcedure(ChannelPermission.SEND_MESSAGES, {
  preview: 'permit',
  serverPermission: Permission.SEND_MESSAGES
})
  .input(
    z.object({
      content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH, 'Message is too long'),
      sendAt: z.number().int().positive(),
      files: z
        .array(z.string().min(1).max(MAX_TEMP_FILE_ID_LENGTH))
        .max(MAX_FILES_PER_POST)
        .optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const { channel } = ctx;

    await assertNotTimedOut(ctx, channel.serverId);
    await assertCanPostInChannel(ctx, channel);

    invariant(channel.type !== ChannelType.VOICE, {
      code: 'BAD_REQUEST',
      message: 'Voice channels do not support text messages'
    });

    // The row is sent by the server later, as plaintext — it cannot
    // produce the author's ciphertext.
    invariant(!channel.e2ee, {
      code: 'BAD_REQUEST',
      message: 'Encrypted channels do not support scheduled messages'
    });

    const files = input.files ?? [];
    invariant(input.content.trim().length > 0 || files.length > 0, {
      code: 'BAD_REQUEST',
      message: 'A scheduled message needs content or files'
    });

    const now = Date.now();
    invariant(
      input.sendAt >= now + MIN_SEND_LEAD_MS && input.sendAt <= now + MAX_SEND_LEAD_MS,
      {
        code: 'BAD_REQUEST',
        message: 'A message is scheduled between 2 minutes and 30 days from now'
      }
    );

    const [pending] = await db
      .select({ n: count() })
      .from(scheduledPosts)
      .where(
        and(
          eq(scheduledPosts.userId, ctx.userId),
          isNull(scheduledPosts.sentMessageId),
          isNull(scheduledPosts.cancelledAt)
        )
      );
    invariant((pending?.n ?? 0) < MAX_PENDING_PER_USER, {
      code: 'BAD_REQUEST',
      message: `You already have ${MAX_PENDING_PER_USER} scheduled messages waiting`
    });

    if (input.content) {
      const automodResult = await checkAutomod(
        input.content,
        channel.id,
        ctx.userId,
        channel.serverId
      );

      if (automodResult.blocked && automodResult.actions) {
        await executeAutomodActions(automodResult.actions, {
          channelId: channel.id,
          userId: ctx.userId,
          content: input.content,
          serverId: channel.serverId,
          ruleName: automodResult.matchedRuleName ?? 'Unknown',
          authorId: automodResult.matchedRuleCreatedBy
        });

        ctx.throwValidationError('automod', 'Message blocked by auto-moderation.');
      }
    }

    const [post] = await db
      .insert(scheduledPosts)
      .values({
        channelId: channel.id,
        userId: ctx.userId,
        content: input.content,
        sendAt: input.sendAt,
        createdAt: now
      })
      .returning();

    for (const tempFileId of files) {
      const saved = await fileManager.saveFile(tempFileId, ctx.userId);

      await db.insert(scheduledPostFiles).values({
        scheduledPostId: post!.id,
        fileId: saved.id,
        createdAt: now
      });
    }

    publishScheduledPostUpdate(channel.id);

    return post!.id;
  });

export { createScheduledPostRoute };
