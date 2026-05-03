import type http from 'http';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { messages, webhooks } from '../db/schema';
import { publishMessage } from '../db/publishers';
import { logger } from '../logger';
import { getJsonBody, JsonBodyTooLargeError } from './helpers';

// Webhook payloads can include a longer content blob (4 KB cap on the
// content field below) plus username/avatar — 32 KB is a comfortable
// upper bound for the wrapping JSON.
const WEBHOOK_BODY_LIMIT_BYTES = 32 * 1024;

const webhookRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webhookId: number,
  token: string
) => {
  // Look up webhook by id + token
  const [webhook] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.token, token)))
    .limit(1);

  if (!webhook) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Webhook not found' }));
    return;
  }

  let parsed: {
    content?: string;
    username?: string;
    avatar_url?: string;
  };

  try {
    parsed = await getJsonBody(req, { maxBytes: WEBHOOK_BODY_LIMIT_BYTES });
  } catch (err) {
    if (err instanceof JsonBodyTooLargeError) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  if (!parsed.content || typeof parsed.content !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Content is required' }));
    return;
  }

  if (parsed.content.length > 4000) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Content exceeds maximum length of 4000 characters' }));
    return;
  }

  // Use payload username override, or fall back to webhook name as alias
  const displayName = parsed.username || webhook.name;

  // Insert message with webhookId
  const [message] = await db
    .insert(messages)
    .values({
      content: parsed.content,
      userId: webhook.createdBy,
      channelId: webhook.channelId,
      webhookId: webhook.id,
      metadata: [
        {
          url: '',
          title: displayName,
          siteName: 'webhook',
          description: '',
          mediaType: 'webhook'
        }
      ],
      createdAt: Date.now()
    })
    .returning();

  if (!message) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to create message' }));
    return;
  }

  await publishMessage(message.id, webhook.channelId, 'create');

  logger.info(
    'Webhook %s (%d) sent message to channel %d',
    webhook.name,
    webhook.id,
    webhook.channelId
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: message.id }));
};

export { webhookRouteHandler };
