import {
  ActivityLogType,
  ChannelPermission,
  ChannelType,
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
import { channels, messageFiles, messages } from '../../db/schema';
import { getInvokerCtxFromTrpcCtx } from '../../helpers/get-invoker-ctx-from-trpc-ctx';
import { getPlainTextFromHtml } from '../../helpers/get-plain-text-from-html';
import { parseCommandArgs } from '../../helpers/parse-command-args';
import { parseMentionedUserIds } from '../../helpers/parse-mentions';
import { pluginManager } from '../../plugins';
import { eventBus } from '../../plugins/event-bus';
import { enqueueActivityLog } from '../../queues/activity-log';
import { enqueueProcessMetadata } from '../../queues/message-metadata';
import {
  assertNotTimedOut,
  checkAutomod,
  executeAutomodActions
} from '../../utils/automod';
import { fileManager } from '../../utils/file-manager';
import { invariant } from '../../utils/invariant';
import { logger } from '../../logger';
import { serverProcedure } from '../../utils/procedures';
import { resolveForwardSource } from '../../utils/forward-source';

/**
 * Bounds on the attachment list: each id is a `saveFile` (disk + DB
 * work), so the array is capped; temp ids are UUIDs, never longer.
 */
const MAX_FILES_PER_MESSAGE = 10;
const MAX_TEMP_FILE_ID_LENGTH = 64;

const sendMessageRoute = serverProcedure()
  .input(
    z.object({
      channelId: z.number().int().positive(),
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
    // Permission checks first: previewers and private-channel outsiders
    // are refused as FORBIDDEN (the channel check already denies
    // cross-server ids). The scoped load below is the row the handler
    // works from; it reads as NOT_FOUND only for ids the check let past.
    await Promise.all([
      ctx.needsPermission(Permission.SEND_MESSAGES),
      ctx.needsChannelPermission(
        input.channelId,
        ChannelPermission.SEND_MESSAGES
      )
    ]);

    const [channel] = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, input.channelId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    // An automod timeout locks the member out of sending in this server
    // until the deadline (MANAGE_USERS bypasses).
    await assertNotTimedOut(ctx, channel.serverId);

    const isE2ee = !!input.e2ee;

    // Voice channels have no chat. The UI no longer offers one, but the
    // capability must be gated here too — otherwise messages could still
    // be pushed into voice channels via the raw API.
    invariant(channel.type !== ChannelType.VOICE, {
      code: 'BAD_REQUEST',
      message: 'Voice channels do not support text messages'
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
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, input.replyToId))
        .limit(1);

      invariant(replyTarget && replyTarget.channelId === channel.id, {
        code: 'BAD_REQUEST',
        message: 'Reply target not found in this channel'
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
        ctx.activeServerId
      );

      if (enablePlugins) {
        const plainText = getPlainTextFromHtml(content);
        const { args, commandName } = parseCommandArgs(plainText);
        const foundCommand = pluginManager.getCommandByName(commandName);

        if (foundCommand) {
          if (await ctx.hasPermission(Permission.EXECUTE_PLUGIN_COMMANDS)) {
            const argsObject: Record<string, unknown> = {};

            if (foundCommand.args) {
              foundCommand.args.forEach((argDef, index) => {
                if (index < args.length) {
                  const value = args[index];

                  if (argDef.type === 'number') {
                    argsObject[argDef.name] = Number(value);
                  } else if (argDef.type === 'boolean') {
                    argsObject[argDef.name] = value === 'true';
                  } else {
                    argsObject[argDef.name] = value;
                  }
                }
              });
            }

            const plugin = await pluginManager.getPluginInfo(
              foundCommand?.pluginId || ''
            );

            editable = false;
            targetContent = toDomCommand(
              { ...foundCommand, imageUrl: plugin?.logo, status: 'pending' },
              args
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
                    status
                  },
                  args
                );

                db.update(messages)
                  .set({ content: updatedContent })
                  .where(eq(messages.id, messageId))
                  .execute()
                  .then(() => {
                    publishMessage(messageId, input.channelId, 'update');
                  })
                  .catch((err) => {
                    logger.error('[Plugin] Failed to update command message: %o', err);
                  });
              };

              pluginManager
                .executeCommand(
                  foundCommand.pluginId,
                  foundCommand.name,
                  getInvokerCtxFromTrpcCtx(ctx),
                  argsObject
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
                      args: argsObject
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

    if (input.files && input.files.length > 0) {
      for (const tempFileId of input.files) {
        const newFile = await fileManager.saveFile(tempFileId, ctx.userId);

        await db.insert(messageFiles).values({
          messageId: message!.id,
          fileId: newFile.id,
          createdAt: Date.now()
        });
      }
    }

    publishMessage(message!.id, input.channelId, 'create');

    if (!isE2ee && targetContent) {
      enqueueProcessMetadata(targetContent, message!.id);

      eventBus.emit('message:created', {
        messageId: message!.id,
        channelId: input.channelId,
        userId: ctx.userId,
        content: targetContent
      });
    }

    return message!.id;
  });

export { sendMessageRoute };
