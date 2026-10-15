import { ChannelType, MAX_MESSAGE_CONTENT_LENGTH } from '@pulse/shared';
import { timingSafeEqual } from 'crypto';
import type http from 'http';
import { eq } from 'drizzle-orm';
import z from 'zod';
import { db } from '../db';
import { channels, files, messages, webhooks } from '../db/schema';
import { publishMessage } from '../db/publishers';
import { logger } from '../logger';
import { checkAutomod, executeAutomodActions } from '../utils/automod';
import { getJsonBody, JsonBodyTooLargeError } from './helpers';

// Webhook payloads are a content blob (capped at the shared message
// limit below) plus a short username — 256 KB is a comfortable upper bound
// for the wrapping JSON.
const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

// Tokens are UUIDs (36 chars); anything much longer is not ours.
const MAX_TOKEN_LENGTH = 128;

// Postgres `serial` ceiling — larger ids can't exist and would make the
// lookup throw "out of range" instead of 404.
const MAX_SERIAL_ID = 2_147_483_647;

/**
 * Accepted body. `avatar_url` is deliberately NOT part of the schema: the
 * server never fetches attacker-supplied URLs on a webhook's behalf. The
 * only avatar a webhook message carries is the one configured on the
 * webhook itself (`webhooks.avatarFileId`, see below); unknown keys are
 * stripped by zod.
 */
const zBody = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'Content is required')
    .max(
      MAX_MESSAGE_CONTENT_LENGTH,
      `Content exceeds maximum length of ${MAX_MESSAGE_CONTENT_LENGTH} characters`
    ),
  // Empty / whitespace-only overrides fall back to the webhook's name.
  username: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((value) => value || undefined)
});

const json = (res: http.ServerResponse, status: number, body: object) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Constant-time string equality; a length mismatch is still a full compare. */
const tokensMatch = (expected: string, presented: string): boolean => {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
};

const webhookRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webhookId: number,
  rawToken: string
) => {
  // The route regex captures everything after the id, which includes any
  // query string a caller (or their HTTP library) appended. The token is
  // the path segment only.
  const token = rawToken.split(/[?#]/, 1)[0] ?? '';

  if (
    !Number.isSafeInteger(webhookId) ||
    webhookId <= 0 ||
    webhookId > MAX_SERIAL_ID ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return json(res, 404, { error: 'Webhook not found' });
  }

  // Look up by id only, then compare the token in constant time — a
  // `WHERE token = $1` would let the index lookup's timing leak how much
  // of a guessed token matched.
  const [webhook] = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.id, webhookId))
    .limit(1);

  if (!webhook || !tokensMatch(webhook.token, token)) {
    return json(res, 404, { error: 'Webhook not found' });
  }

  const [channel] = await db
    .select({
      type: channels.type,
      e2ee: channels.e2ee,
      serverId: channels.serverId
    })
    .from(channels)
    .where(eq(channels.id, webhook.channelId))
    .limit(1);

  if (!channel) {
    return json(res, 404, { error: 'Webhook not found' });
  }

  // Voice channels have no chat. Creation of voice-channel webhooks is
  // gated in webhooks.create, but webhooks created BEFORE that gate (or
  // whose channel later changed) still exist — without this check they
  // would keep injecting messages no client can display.
  if (channel.type === ChannelType.VOICE) {
    return json(res, 400, {
      error: 'Voice channels do not support text messages'
    });
  }

  // A webhook cannot encrypt: posting into an E2EE channel would inject
  // server-readable plaintext where members expect ciphertext only
  // (send-message.ts refuses the same for users).
  if (channel.e2ee) {
    return json(res, 400, {
      error: 'Webhooks cannot post into end-to-end encrypted channels'
    });
  }

  let raw: unknown;

  try {
    raw = await getJsonBody(req, { maxBytes: WEBHOOK_BODY_LIMIT_BYTES });
  } catch (err) {
    if (err instanceof JsonBodyTooLargeError) {
      return json(res, 413, { error: err.message });
    }
    return json(res, 400, { error: 'Invalid JSON body' });
  }

  const parsedBody = zBody.safeParse(raw);

  if (!parsedBody.success) {
    const issue = parsedBody.error.issues[0];
    return json(res, 400, {
      error: issue?.message ?? 'Invalid webhook payload'
    });
  }

  const { content, username } = parsedBody.data;

  // Same auto-moderation the user send path runs; the webhook's creator
  // is the accountable user for role exemptions and alerts.
  const automodResult = await checkAutomod(
    content,
    webhook.channelId,
    webhook.createdBy,
    channel.serverId
  );

  if (automodResult.blocked) {
    if (automodResult.actions) {
      await executeAutomodActions(automodResult.actions, {
        channelId: webhook.channelId,
        userId: webhook.createdBy,
        content,
        serverId: channel.serverId,
        ruleName: automodResult.matchedRuleName ?? 'Unknown'
      });
    }
    return json(res, 400, { error: 'Message blocked by auto-moderation' });
  }

  // Persona: payload username override, else the webhook's name. The
  // avatar is the webhook's configured file (if any), snapshotted onto the
  // message like the alias so later edits to the webhook don't rewrite
  // history. `images[0]` is the server-relative public path of that file —
  // clients prefix it with the origin they loaded the message from.
  const displayName = username || webhook.name;
  let avatarPath: string | undefined;

  if (webhook.avatarFileId) {
    const [avatar] = await db
      .select({ name: files.name })
      .from(files)
      .where(eq(files.id, webhook.avatarFileId))
      .limit(1);
    if (avatar) avatarPath = `/public/${avatar.name}`;
  }

  const [message] = await db
    .insert(messages)
    .values({
      content,
      userId: webhook.createdBy,
      channelId: webhook.channelId,
      webhookId: webhook.id,
      metadata: [
        {
          url: '',
          title: displayName,
          siteName: 'webhook',
          description: '',
          mediaType: 'webhook',
          ...(avatarPath ? { images: [avatarPath] } : {})
        }
      ],
      createdAt: Date.now()
    })
    .returning();

  if (!message) {
    return json(res, 500, { error: 'Failed to create message' });
  }

  await publishMessage(message.id, webhook.channelId, 'create');

  logger.info(
    'Webhook %s (%d) sent message to channel %d',
    webhook.name,
    webhook.id,
    webhook.channelId
  );

  return json(res, 200, { id: message.id });
};

export { webhookRouteHandler };
