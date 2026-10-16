import {
  ChannelPermission,
  ChannelType,
  MAX_MESSAGE_CONTENT_LENGTH,
  Permission,
  ServerEvents
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel, publishMessage } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import {
  channels,
  forumPostTags,
  messageFiles,
  messages,
  threadFollowers
} from '../../db/schema';
import { parseMentionedUserIds } from '../../helpers/parse-mentions';
import { fileManager } from '../../utils/file-manager';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { pubsub } from '../../utils/pubsub';
import {
  copyParentOverrides,
  getThreadViewerIds,
  MAX_FILES_PER_POST,
  MAX_TAGS_PER_POST,
  MAX_TEMP_FILE_ID_LENGTH,
  publishPrivateThreadPermissions,
  resolveForumTagIds
} from './_shared';

const createForumPostRoute = serverProcedure(Permission.SEND_MESSAGES)
  .input(
    z.object({
      channelId: z.number().int().positive(),
      title: z.string().min(1).max(200),
      // Same plaintext budget as an ordinary message in the thread.
      content: z.string().min(1).max(MAX_MESSAGE_CONTENT_LENGTH),
      tagIds: z
        .array(z.number().int().positive())
        .max(MAX_TAGS_PER_POST)
        .optional(),
      files: z
        .array(z.string().min(1).max(MAX_TEMP_FILE_ID_LENGTH))
        .max(MAX_FILES_PER_POST)
        .optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Verify the channel exists, is a FORUM type, and is in the active server
    const [forumChannel] = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, input.channelId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    if (!forumChannel || forumChannel.type !== ChannelType.FORUM) {
      return ctx.throwValidationError('channelId', 'Forum channel not found');
    }

    // Channel-level check (implies VIEW): the server-level SEND_MESSAGES
    // the builder verified says nothing about a private forum.
    await ctx.needsChannelPermission(
      forumChannel.id,
      ChannelPermission.SEND_MESSAGES
    );

    // The opening post is plaintext by construction; it cannot live in
    // an encrypted thread, and an encrypted forum has no way to carry it.
    invariant(!forumChannel.e2ee, {
      code: 'BAD_REQUEST',
      message: 'Encrypted forums do not support posts'
    });

    const tagIds = await resolveForumTagIds(forumChannel.id, input.tagIds);

    const now = Date.now();

    const result = await db.transaction(async (tx) => {
      // Create thread channel for the forum post. Visibility is
      // inherited: a public post under a private forum would leak it.
      const [thread] = await tx
        .insert(channels)
        .values({
          type: ChannelType.THREAD,
          name: input.title,
          position: 0,
          fileAccessToken: randomUUIDv7(),
          fileAccessTokenUpdatedAt: now,
          serverId: forumChannel.serverId,
          parentChannelId: forumChannel.id,
          private: forumChannel.private,
          e2ee: forumChannel.e2ee,
          archived: false,
          autoArchiveDuration: 1440,
          publicId: randomUUIDv7(),
          createdAt: now
        })
        .returning();

      if (forumChannel.private) {
        await copyParentOverrides(tx, forumChannel.id, thread!.id, now);
      }

      // Create the initial message in the thread
      const [firstMessage] = await tx
        .insert(messages)
        .values({
          content: input.content,
          userId: ctx.userId,
          channelId: thread!.id,
          createdAt: now
        })
        .returning();

      // Attach tags if provided
      if (tagIds.length > 0) {
        await tx.insert(forumPostTags).values(
          tagIds.map((tagId) => ({
            threadId: thread!.id,
            tagId
          }))
        );
      }

      // Auto-follow the creator
      await tx
        .insert(threadFollowers)
        .values({
          threadId: thread!.id,
          userId: ctx.userId,
          createdAt: now
        })
        .onConflictDoNothing();

      return { thread: thread!, message: firstMessage! };
    });

    // Parse @mentions in the initial post content
    const channelMemberIds = await getAffectedUserIdsForChannel(
      result.thread.id
    );
    const { userIds: mentionedUserIds, mentionsAll } =
      await parseMentionedUserIds(input.content, channelMemberIds);

    if (mentionedUserIds.length > 0 || mentionsAll) {
      await db
        .update(messages)
        .set({
          mentionedUserIds: mentionedUserIds.length > 0 ? mentionedUserIds : null,
          mentionsAll
        })
        .where(eq(messages.id, result.message.id));
    }

    // Attach files to the initial message
    if (input.files && input.files.length > 0) {
      for (const tempFileId of input.files) {
        const newFile = await fileManager.saveFile(tempFileId, ctx.userId);

        await db.insert(messageFiles).values({
          messageId: result.message.id,
          fileId: newFile.id,
          createdAt: Date.now()
        });
      }
    }

    // Publish events
    publishChannel(result.thread.id, 'create');
    publishMessage(result.message.id, result.thread.id, 'create');

    const viewerIds = await getThreadViewerIds(result.thread.id);
    await publishPrivateThreadPermissions(forumChannel.private, viewerIds);
    pubsub.publishFor(viewerIds, ServerEvents.THREAD_CREATE, {
      id: result.thread.id,
      name: result.thread.name,
      messageCount: 1,
      lastMessageAt: now,
      archived: false,
      parentChannelId: forumChannel.id,
      creatorId: ctx.userId
    });

    return { threadId: result.thread.id };
  });

export { createForumPostRoute };
