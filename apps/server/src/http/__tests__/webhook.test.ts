import {
  AutomodRuleType,
  ChannelType,
  MAX_MESSAGE_CONTENT_LENGTH
} from '@pulse/shared';
import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { eq } from 'drizzle-orm';
import { createTestChannel } from '../../__tests__/fixtures';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import { automodRules, files, messages, webhooks } from '../../db/schema';

const TEXT_CHANNEL_ID = 1;

const insertWebhook = async (args: {
  channelId: number;
  avatarFileId?: number;
  name?: string;
}) => {
  const token = `tok-${randomUUIDv7()}`;
  const [hook] = await getTestDb()
    .insert(webhooks)
    .values({
      name: args.name ?? 'ci-hook',
      channelId: args.channelId,
      token,
      avatarFileId: args.avatarFileId ?? null,
      createdBy: 1,
      serverId: 1,
      createdAt: Date.now()
    })
    .returning();
  return { id: hook!.id, token };
};

const post = (id: number, token: string, body: unknown, suffix = '') =>
  fetch(`${testsBaseUrl}/webhooks/${id}/${token}${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });

const messageById = async (id: number) => {
  const [row] = await getTestDb()
    .select()
    .from(messages)
    .where(eq(messages.id, id))
    .limit(1);
  return row;
};

describe('POST /webhooks/:id/:token', () => {
  test('posts a message attributed to the webhook persona', async () => {
    const hook = await insertWebhook({ channelId: TEXT_CHANNEL_ID, name: 'Deploys' });

    const response = await post(hook.id, hook.token, { content: 'build green' });
    expect(response.status).toBe(200);

    const { id } = (await response.json()) as { id: number };
    const message = await messageById(id);
    expect(message?.webhookId).toBe(hook.id);
    expect(message?.channelId).toBe(TEXT_CHANNEL_ID);
    expect(message?.content).toBe('build green');
    expect(message?.metadata?.[0]).toMatchObject({
      mediaType: 'webhook',
      title: 'Deploys'
    });
  });

  test('a blank username override falls back to the webhook name', async () => {
    const hook = await insertWebhook({ channelId: TEXT_CHANNEL_ID, name: 'Deploys' });

    const response = await post(hook.id, hook.token, { content: 'x', username: '   ' });
    expect(response.status).toBe(200);

    const { id } = (await response.json()) as { id: number };
    expect((await messageById(id))?.metadata?.[0]?.title).toBe('Deploys');
  });

  test('a wrong token is a 404 (same as an unknown webhook)', async () => {
    const hook = await insertWebhook({ channelId: TEXT_CHANNEL_ID });

    const wrongToken = await post(hook.id, `${hook.token}x`, { content: 'nope' });
    expect(wrongToken.status).toBe(404);

    const unknownId = await post(hook.id + 100_000, hook.token, { content: 'nope' });
    expect(unknownId.status).toBe(404);

    const rows = await getTestDb()
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.webhookId, hook.id));
    expect(rows.length).toBe(0);
  });

  test('a query string after the token is ignored, not treated as part of it', async () => {
    const hook = await insertWebhook({ channelId: TEXT_CHANNEL_ID });

    const response = await post(hook.id, hook.token, { content: 'hi' }, '?wait=true');
    expect(response.status).toBe(200);
  });

  test('refuses to post into an end-to-end encrypted channel', async () => {
    const e2eeChannelId = await createTestChannel({ serverId: 1, e2ee: true });
    const hook = await insertWebhook({ channelId: e2eeChannelId });

    const response = await post(hook.id, hook.token, { content: 'plaintext' });
    expect(response.status).toBe(400);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain('encrypted');

    const rows = await getTestDb()
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.channelId, e2eeChannelId));
    expect(rows.length).toBe(0);
  });

  test('refuses to post into a voice channel', async () => {
    const voiceChannelId = await createTestChannel({
      serverId: 1,
      type: ChannelType.VOICE
    });
    const hook = await insertWebhook({ channelId: voiceChannelId });

    const response = await post(hook.id, hook.token, { content: 'into voice' });
    expect(response.status).toBe(400);

    const data = (await response.json()) as { error: string };
    expect(data.error).toContain('Voice channels');
  });

  test('a 100 KB username is rejected (400), as is one over 80 characters', async () => {
    const hook = await insertWebhook({ channelId: TEXT_CHANNEL_ID });

    const huge = await post(hook.id, hook.token, {
      content: 'x',
      username: 'u'.repeat(100 * 1024)
    });
    expect(huge.status).toBe(400);

    const justOver = await post(hook.id, hook.token, {
      content: 'x',
      username: 'u'.repeat(81)
    });
    expect(justOver.status).toBe(400);

    const atLimit = await post(hook.id, hook.token, {
      content: 'x',
      username: 'u'.repeat(80)
    });
    expect(atLimit.status).toBe(200);
  });

  test('content up to the shared message limit is accepted; over it is 400', async () => {
    const hook = await insertWebhook({ channelId: TEXT_CHANNEL_ID });

    const tenThousand = await post(hook.id, hook.token, {
      content: 'c'.repeat(10_000)
    });
    expect(tenThousand.status).toBe(200);

    const overLimit = await post(hook.id, hook.token, {
      content: 'c'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
    });
    expect(overLimit.status).toBe(400);
  });

  test('empty, whitespace-only, non-string content and malformed JSON are 400', async () => {
    const hook = await insertWebhook({ channelId: TEXT_CHANNEL_ID });

    expect((await post(hook.id, hook.token, { content: '' })).status).toBe(400);
    expect((await post(hook.id, hook.token, { content: '   ' })).status).toBe(400);
    expect((await post(hook.id, hook.token, { content: 42 })).status).toBe(400);
    expect((await post(hook.id, hook.token, {})).status).toBe(400);
    expect((await post(hook.id, hook.token, '{not json')).status).toBe(400);
  });

  test('the message carries the username override and the webhook avatar; avatar_url is never fetched', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch');
    try {
      const tdb = getTestDb();
      const avatarName = `hook-avatar-${randomUUIDv7()}.png`;
      const [avatar] = await tdb
        .insert(files)
        .values({
          name: avatarName,
          originalName: 'avatar.png',
          md5: 'd41d8cd98f00b204e9800998ecf8427e',
          userId: 1,
          size: 12,
          mimeType: 'image/png',
          extension: '.png',
          createdAt: Date.now()
        })
        .returning({ id: files.id });

      const hook = await insertWebhook({
        channelId: TEXT_CHANNEL_ID,
        avatarFileId: avatar!.id,
        name: 'Alerts'
      });

      // Only our own request goes through fetch — the attacker-supplied
      // avatar_url must never be retrieved by the server.
      const callsBefore = fetchSpy.mock.calls.length;
      const response = await post(hook.id, hook.token, {
        content: 'disk 91%',
        username: 'Grafana',
        avatar_url: 'http://169.254.169.254/latest/meta-data/'
      });
      expect(response.status).toBe(200);
      expect(fetchSpy.mock.calls.length).toBe(callsBefore + 1);

      const { id } = (await response.json()) as { id: number };
      const message = await messageById(id);
      expect(message?.metadata?.[0]).toMatchObject({
        mediaType: 'webhook',
        title: 'Grafana',
        images: [`/public/${avatarName}`]
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('a webhook without an avatar carries no image', async () => {
    const hook = await insertWebhook({ channelId: TEXT_CHANNEL_ID });

    const response = await post(hook.id, hook.token, {
      content: 'plain',
      avatar_url: 'https://example.com/x.png'
    });
    expect(response.status).toBe(200);

    const { id } = (await response.json()) as { id: number };
    const message = await messageById(id);
    expect(message?.metadata?.[0]?.images).toBeUndefined();
  });

  test('auto-moderation rules apply to webhook posts', async () => {
    await getTestDb()
      .insert(automodRules)
      .values({
        serverId: 1,
        name: 'no-forbidden',
        type: AutomodRuleType.KEYWORD_FILTER,
        enabled: true,
        config: { keywords: ['forbidden'] },
        actions: [{ type: 'log' }],
        createdBy: 1,
        createdAt: Date.now()
      });
    const hook = await insertWebhook({ channelId: TEXT_CHANNEL_ID });

    const blocked = await post(hook.id, hook.token, {
      content: 'this is FORBIDDEN'
    });
    expect(blocked.status).toBe(400);
    const data = (await blocked.json()) as { error: string };
    expect(data.error).toContain('auto-moderation');

    const allowed = await post(hook.id, hook.token, { content: 'this is fine' });
    expect(allowed.status).toBe(200);
  });
});
