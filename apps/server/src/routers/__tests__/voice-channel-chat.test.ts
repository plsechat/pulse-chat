import { ChannelType } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import { channels, webhooks } from '../../db/schema';

// Voice channels have no chat: the client no longer renders one, and the
// API layer must reject the capability too — both direct message sends
// and webhook creation (a webhook pointed at a voice channel could still
// inject messages).
const createVoiceChannel = async (name: string, position: number) => {
  const [channel] = await getTestDb()
    .insert(channels)
    .values({
      type: ChannelType.VOICE,
      name,
      position,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      publicId: randomUUIDv7(),
      categoryId: 1,
      serverId: 1,
      createdAt: Date.now()
    })
    .returning();

  return channel!;
};

describe('voice channels have no chat', () => {
  test('messages.send into a VOICE channel is rejected', async () => {
    const { caller } = await initTest(1);
    const voice = await createVoiceChannel('Voice Gate A', 90);

    await expect(
      caller.messages.send({
        channelId: voice.id,
        content: 'hello?',
        files: []
      })
    ).rejects.toThrow('Voice channels do not support text messages');
  });

  test('messages.send into a TEXT channel still works', async () => {
    const { caller } = await initTest(1);

    // Control: the added channel-type check must not affect text channels
    await caller.messages.send({
      channelId: 1,
      content: 'control message',
      files: []
    });

    const result = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 10
    });

    expect(
      result.messages.some((m) => m.content === 'control message')
    ).toBe(true);
  });

  test('webhooks.create targeting a VOICE channel is rejected', async () => {
    const { caller } = await initTest(1);
    const voice = await createVoiceChannel('Voice Gate B', 91);

    await expect(
      caller.webhooks.create({ name: 'voice-hook', channelId: voice.id })
    ).rejects.toThrow('Webhooks cannot target voice channels');
  });

  test('webhooks.create targeting a TEXT channel still works', async () => {
    const { caller } = await initTest(1);

    const webhook = await caller.webhooks.create({
      name: 'text-hook',
      channelId: 1
    });

    expect(webhook?.channelId).toBe(1);
  });

  test('webhook RECEIVE into a VOICE channel is rejected (legacy pre-gate webhooks)', async () => {
    await initTest(1);
    const voice = await createVoiceChannel('Voice Gate C', 92);

    // Simulate a webhook created BEFORE the creation gate existed: insert
    // the row directly, pointing at a voice channel.
    const [hook] = await getTestDb()
      .insert(webhooks)
      .values({
        name: 'legacy-voice-hook',
        channelId: voice.id,
        token: 'legacy-voice-token',
        createdBy: 1,
        serverId: 1,
        createdAt: Date.now()
      })
      .returning();

    const response = await fetch(
      `${testsBaseUrl}/webhooks/${hook!.id}/legacy-voice-token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'injected into voice' })
      }
    );

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain('Voice channels');
  });

  test('webhook RECEIVE into a TEXT channel still works', async () => {
    await initTest(1);

    const [hook] = await getTestDb()
      .insert(webhooks)
      .values({
        name: 'text-hook-receive',
        channelId: 1,
        token: 'text-hook-token',
        createdBy: 1,
        serverId: 1,
        createdAt: Date.now()
      })
      .returning();

    const response = await fetch(
      `${testsBaseUrl}/webhooks/${hook!.id}/text-hook-token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'webhook control message' })
      }
    );

    expect(response.status).toBe(200);
  });
});
