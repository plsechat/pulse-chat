import {
  ChannelPermission,
  ChannelType,
  Permission
} from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { publishMessage } from '../../db/publishers';
import { buildPollView } from '../../db/queries/polls';
import { messages, polls } from '../../db/schema';
import { assertCanPostInChannel } from '../../utils/announcement-gate';
import {
  assertNotTimedOut,
  checkAutomod,
  executeAutomodActions
} from '../../utils/automod';
import { invariant } from '../../utils/invariant';
import { channelProcedure } from '../../utils/procedures';

const MAX_QUESTION_LENGTH = 200;
const MAX_OPTION_LENGTH = 80;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
/** A deadline must be at least this far ahead and at most this far. */
const MIN_CLOSE_LEAD_MS = 60 * 1000;
const MAX_CLOSE_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

const trimmed = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(max));

/**
 * A poll is a message of type 'poll' (its content is the question, so
 * search, notifications and the channel list all have something to
 * show) plus a polls row that owns the options and votes. Same gates as
 * a text send: SEND_MESSAGES at both levels, the timeout, the
 * announcement rule and automod over the question and the options.
 * Option keys are minted here — the client never chooses them.
 */
const createPollRoute = channelProcedure(ChannelPermission.SEND_MESSAGES, {
  preview: 'permit',
  serverPermission: Permission.SEND_MESSAGES
})
  .input(
    z.object({
      question: trimmed(MAX_QUESTION_LENGTH),
      options: z.array(trimmed(MAX_OPTION_LENGTH)).min(MIN_OPTIONS).max(MAX_OPTIONS),
      multiple: z.boolean().optional(),
      anonymous: z.boolean().optional(),
      closesAt: z.number().int().positive().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const { channel } = ctx;

    await assertNotTimedOut(ctx, channel.serverId);
    await assertCanPostInChannel(ctx, channel);

    invariant(channel.type !== ChannelType.VOICE, {
      code: 'BAD_REQUEST',
      message: 'Voice channels do not support polls'
    });

    // Votes are tallied by the server, so the question and options are
    // necessarily plaintext — an encrypted channel cannot carry one.
    invariant(!channel.e2ee, {
      code: 'BAD_REQUEST',
      message: 'Encrypted channels do not support polls'
    });

    const labels = input.options;
    invariant(new Set(labels.map((l) => l.toLowerCase())).size === labels.length, {
      code: 'BAD_REQUEST',
      message: 'Poll options must be distinct'
    });

    const now = Date.now();

    if (input.closesAt !== undefined) {
      invariant(
        input.closesAt >= now + MIN_CLOSE_LEAD_MS &&
          input.closesAt <= now + MAX_CLOSE_LEAD_MS,
        {
          code: 'BAD_REQUEST',
          message: 'A poll closes between one minute and 30 days from now'
        }
      );
    }

    const automodText = [input.question, ...labels].join('\n');
    const automodResult = await checkAutomod(
      automodText,
      channel.id,
      ctx.userId,
      channel.serverId
    );

    if (automodResult.blocked && automodResult.actions) {
      await executeAutomodActions(automodResult.actions, {
        channelId: channel.id,
        userId: ctx.userId,
        content: automodText,
        serverId: channel.serverId,
        ruleName: automodResult.matchedRuleName ?? 'Unknown',
        authorId: automodResult.matchedRuleCreatedBy
      });

      ctx.throwValidationError('automod', 'Poll blocked by auto-moderation.');
    }

    const [message] = await db
      .insert(messages)
      .values({
        channelId: channel.id,
        userId: ctx.userId,
        content: input.question,
        type: 'poll',
        // The card is the only editor of a poll (close), never the
        // text edit route.
        editable: false,
        createdAt: now
      })
      .returning();

    const [poll] = await db
      .insert(polls)
      .values({
        messageId: message!.id,
        channelId: channel.id,
        question: input.question,
        options: labels.map((label, index) => ({ key: `o${index + 1}`, label })),
        multiple: input.multiple ?? false,
        anonymous: input.anonymous ?? false,
        closesAt: input.closesAt ?? null,
        createdBy: ctx.userId,
        createdAt: now
      })
      .returning();

    publishMessage(message!.id, channel.id, 'create');

    return buildPollView(poll!, ctx.userId);
  });

export { createPollRoute };
