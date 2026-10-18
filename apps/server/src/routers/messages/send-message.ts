import {
  ActivityLogType,
  ChannelPermission,
  ChannelType,
  MAX_FILES_PER_MESSAGE,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_MESSAGE_WIRE_LENGTH,
  Permission,
  toDomCommand
} from '@pulse/shared';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishMessage } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { messageFiles, messages } from '../../db/schema';
import { getInvokerCtxFromTrpcCtx } from '../../helpers/get-invoker-ctx-from-trpc-ctx';
import { getPlainTextFromHtml } from '../../helpers/get-plain-text-from-html';
import {
  coerceCommandArgs,
  parseCommandArgs,
  resolveCommandInvocation
} from '../../helpers/parse-command-args';
import { parseMentionedUserIds } from '../../helpers/parse-mentions';
import { logger } from '../../logger';
import { pluginManager } from '../../plugins';
import { eventBus } from '../../plugins/event-bus';
import { enqueueActivityLog } from '../../queues/activity-log';
import { enqueueProcessMetadata } from '../../queues/message-metadata';
import { relayAnnouncement } from '../../utils/announcement-follow';
import { assertCanPostInChannel } from '../../utils/announcement-gate';
import {
  assertNotTimedOut,
  checkAutomod,
  executeAutomodActions
} from '../../utils/automod';
import { fileManager } from '../../utils/file-manager';
import { resolveForwardSource } from '../../utils/forward-source';
import { invariant } from '../../utils/invariant';
import { channelProcedure } from '../../utils/procedures';

/**
 * Bounds on the attachment list: the count cap (MAX_FILES_PER_MESSAGE,
 * shared with the composer) exists because each id is a `saveFile`
 * (disk + DB work); temp ids are UUIDs, never longer.
 */
const MAX_TEMP_FILE_ID_LENGTH = 64;

// Preview 'permit': a preview session holds no SEND_MESSAGES anywhere,
// so the channel permission refuses it like any other outsider. Both
// the channel-level and the server-level SEND_MESSAGES are required.
const sendMessageRoute = channelProcedure(ChannelPermission.SEND_MESSAGES, {
  preview: 'permit',
  serverPermission: Permission.SEND_MESSAGES
})
  .input(
    z.object({
      content: z
        .string()
        .max(MAX_MESSAGE_WIRE_LENGTH, 'Message is too long')
        .optional(),
      e2ee: z.boolean().optional(),
      files: z
        .array(z.string().min(1).max(MAX_TEMP_FILE_ID_LENGTH))
        .max(MAX_FILES_PER_MESSAGE)
        .optional(),
      replyToId: z.number().int().positive().optional(),
      /**
       * Forward attribution by SOURCE REFERENCE — the server loads the
       * source, verifies visibility, and derives the author itself.
       * There is deliberately no way to claim an author directly.
       */
      forwardedFrom: z
        .object({
          sourceKind: z.enum(['channel', 'dm']),
          sourceId: z.number().int().positive()
        })
        .optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const { channel } = ctx;

    // An automod timeout locks the member out of sending in this server
    // until the deadline (MANAGE_USERS bypasses).
    await assertNotTimedOut(ctx, channel.serverId);
    await assertCanPostInChannel(ctx, channel);

    const isE2ee = !!input.e2ee;

    // Voice channels have no chat. The UI no longer offers one, but the
    // capability must be gated here too — otherwise messages could still
    // be pushed into voice channels via the raw API.
    invariant(channel.type !== ChannelType.VOICE, {
      code: 'BAD_REQUEST',
      message: 'Voice channels do not support text messages'
    });

    // An archived thread is closed until a moderator (or the post's
    // author) unarchives it; a reply must not silently reopen it.
    invariant(!channel.archived, {
      code: 'BAD_REQUEST',
      message: 'This thread is archived. Unarchive it to reply.'
    });

    // The channel flag is authoritative in BOTH directions: plaintext
    // into an encrypted channel leaks, and ciphertext into a plaintext
    // channel produces rows that search, automod and link previews
    // silently skip (the DM route has enforced this symmetry all along).
    invariant(channel.e2ee === isE2ee, {
      code: 'BAD_REQUEST',
      message: channel.e2ee
        ? 'This channel requires E2EE messages'
        : 'This channel is not encrypted — encrypted sends are not allowed'
    });

    if (isE2ee) {
      invariant(input.content, {
        code: 'BAD_REQUEST',
        message: 'E2EE messages must include content'
      });
    } else {
      invariant(input.content || (input.files && input.files.length > 0), {
        code: 'BAD_REQUEST',
        message: 'Non-E2EE messages must include content or files'
      });

      // The wire cap exists for ciphertext expansion only; plaintext is
      // held to the composer's budget.
      invariant(
        !input.content || input.content.length <= MAX_MESSAGE_CONTENT_LENGTH,
        {
          code: 'BAD_REQUEST',
          message: 'Message is too long'
        }
      );
    }

    // A reply may only point at a message in the SAME channel: the
    // reply-preview readers ship the target's content to everyone who
    // can see the new message, so an unchecked id would disclose text
    // from private channels, other servers or DMs.
    if (input.replyToId !== undefined) {
      const [replyTarget] = await db
        .select({
          channelId: messages.channelId,
          deletedAt: messages.deletedAt
        })
        .from(messages)
        .where(eq(messages.id, input.replyToId))
        .limit(1);

      invariant(replyTarget && replyTarget.channelId === channel.id, {
        code: 'BAD_REQUEST',
        message: 'Reply target not found in this channel'
      });
      // A reply to a tombstone would quote nothing; the existing replies
      // keep pointing at it (their preview says "Message deleted").
      invariant(!replyTarget.deletedAt, {
        code: 'BAD_REQUEST',
        message: 'You cannot reply to a deleted message'
      });
    }

    // Slow mode enforcement
    if (channel.slowMode > 0) {
      const [lastMessage] = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.userId, ctx.userId),
            eq(messages.channelId, input.channelId)
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(1);

      if (lastMessage) {
        const elapsed = (Date.now() - lastMessage.createdAt) / 1000;

        if (elapsed < channel.slowMode) {
          const remaining = Math.ceil(channel.slowMode - elapsed);

          ctx.throwValidationError(
            'slowMode',
            `Slow mode active. Wait ${remaining} seconds.`
          );
        }
      }
    }

    // Skip automod and plugin processing for E2EE messages
    const content = input.content ?? null;
    let targetContent: string | null = content;
    let editable = true;
    let commandExecutor: ((messageId: number) => void) | undefined = undefined;

    if (!isE2ee && content) {
      // Automod check
      const automodResult = await checkAutomod(
        content,
        input.channelId,
        ctx.userId,
        channel.serverId
      );

      if (automodResult.blocked && automodResult.actions) {
        await executeAutomodActions(automodResult.actions, {
          channelId: input.channelId,
          userId: ctx.userId,
          content,
          serverId: channel.serverId,
          ruleName: automodResult.matchedRuleName ?? 'Unknown',
          authorId: automodResult.matchedRuleCreatedBy
        });

        ctx.throwValidationError(
          'automod',
          'Message blocked by auto-moderation.'
        );
      }

      const enablePlugins = await pluginManager.commandsEnabledForServer(
        channel.serverId
      );
      const plainText = getPlainTextFromHtml(content);
      const { args, commandName } = parseCommandArgs(plainText);
      const foundCommand = commandName
        ? pluginManager.getCommandByName(commandName)
        : undefined;

      // A known command that cannot run here is refused with the reason;
      // posting it as plain text looks like the command silently failed.
      if (foundCommand && !enablePlugins) {
        ctx.throwValidationError(
          'content',
          'Plugin commands are turned off in this community. A member with Manage settings can turn them on under Server Settings → General → Plugins.'
        );
      }
      if (
        foundCommand &&
        !(await ctx.hasPermission(Permission.EXECUTE_PLUGIN_COMMANDS))
      ) {
        ctx.throwValidationError(
          'content',
          'You do not have permission to run plugin commands in this community.'
        );
      }

      if (enablePlugins) {
        if (foundCommand) {
          {
            // `/watch seek 90`: the first token may name a sub-command,
            // whose own arguments then follow it (SDK 0.4.0).
            const invocation = resolveCommandInvocation(foundCommand, args);
            const subcommand = invocation.subcommand?.name;
            const commandArgs = invocation.tokens;
            const argsObject = coerceCommandArgs(
              invocation.argDefs,
              commandArgs
            );

            const plugin = await pluginManager.getPluginInfo(
              foundCommand?.pluginId || ''
            );

            editable = false;
            targetContent = toDomCommand(
              {
                ...foundCommand,
                imageUrl: plugin?.logo,
                status: 'pending',
                subcommand
              },
              commandArgs
            );

            commandExecutor = (messageId: number) => {
              const updateCommandStatus = (
                status: 'completed' | 'failed',
                response?: unknown
              ) => {
                const updatedContent = toDomCommand(
                  {
                    ...foundCommand,
                    imageUrl: plugin?.logo,
                    response,
                    status,
                    subcommand
                  },
                  commandArgs
                );

                db.update(messages)
                  .set({ content: updatedContent })
                  .where(eq(messages.id, messageId))
                  .execute()
                  .then(() => {
                    publishMessage(messageId, input.channelId, 'update');
                  })
                  .catch((err) => {
                    logger.error(
                      '[Plugin] Failed to update command message: %o',
                      err
                    );
                  });
              };

              // The composer's channel travels with the command: a plugin
              // that answers in chat (the watch card) posts there.
              getInvokerCtxFromTrpcCtx(ctx, { channelId: input.channelId })
                .then((invoker) =>
                  pluginManager.executeCommand(
                    foundCommand.pluginId,
                    foundCommand.name,
                    invoker,
                    argsObject,
                    subcommand
                  )
                )
                .then((response) => {
                  updateCommandStatus('completed', response);
                })
                .catch((error) => {
                  updateCommandStatus(
                    'failed',
                    error?.message || 'Unknown error'
                  );
                })
                .finally(() => {
                  enqueueActivityLog({
                    type: ActivityLogType.EXECUTED_PLUGIN_COMMAND,
                    userId: ctx.user.id,
                    details: {
                      pluginId: foundCommand.pluginId,
                      commandName: foundCommand.name,
                      ...(subcommand !== undefined ? { subcommand } : {}),
                      args: pluginManager.redactCommandArgs(
                        foundCommand.pluginId,
                        foundCommand.name,
                        argsObject,
                        subcommand
                      )
                    }
                  });
                });
            };
          }
        }
      }
    }

    // Parse @user, @role, @all mentions from non-E2EE content
    let mentionedUserIds: number[] | null = null;
    let mentionsAll = false;
    if (!isE2ee && targetContent) {
      const memberIds = await getAffectedUserIdsForChannel(input.channelId);
      const parsed = await parseMentionedUserIds(targetContent, memberIds);
      mentionedUserIds = parsed.userIds.length > 0 ? parsed.userIds : null;
      mentionsAll = parsed.mentionsAll;
    }

    const forwarded = input.forwardedFrom
      ? await resolveForwardSource(input.forwardedFrom, ctx)
      : null;
    // A forward is a verbatim copy of someone else's message; letting
    // the forwarder edit it would let them put words under another
    // author's attribution. Lock it (the edit route enforces
    // `editable`).
    if (forwarded) editable = false;

    const [message] = await db
      .insert(messages)
      .values({
        channelId: input.channelId,
        userId: ctx.userId,
        content: targetContent,
        e2ee: isE2ee,
        editable,
        replyToId: input.replyToId,
        mentionedUserIds,
        mentionsAll,
        forwardedFromUserId: forwarded?.forwardedFromUserId,
        forwardedFromName: forwarded?.forwardedFromName,
        createdAt: Date.now()
      })
      .returning();

    commandExecutor?.(message!.id);

    const attachments: { name: string; url: string; size: number }[] = [];
    if (input.files && input.files.length > 0) {
      for (const tempFileId of input.files) {
        const newFile = await fileManager.saveFile(tempFileId, ctx.userId);

        await db.insert(messageFiles).values({
          messageId: message!.id,
          fileId: newFile.id,
          createdAt: Date.now()
        });
        attachments.push({
          name: newFile.name,
          url: `/public/${newFile.name}`,
          size: newFile.size
        });
      }
    }

    publishMessage(message!.id, input.channelId, 'create');
    // Follower channels (local rows, federated relays) get their copy;
    // a no-op for every channel that is not an announcement channel.
    if (channel.announcement) void relayAnnouncement(message!.id, 'create');

    if (!isE2ee && targetContent) {
      enqueueProcessMetadata(targetContent, message!.id);

      eventBus.emit('message:created', {
        messageId: message!.id,
        channelId: input.channelId,
        userId: ctx.userId,
        content: targetContent,
        replyToId: message!.replyToId ?? null,
        attachments
      });
    }

    return message!.id;
  });

export { sendMessageRoute };
