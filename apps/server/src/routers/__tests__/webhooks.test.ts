import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import {
  createTestChannel,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { webhooks } from '../../db/schema';

describe('webhooks router', () => {
  test('full lifecycle: create, get, list, update, delete', async () => {
    const { caller } = await initTest(1);

    const created = await caller.webhooks.create({
      name: 'deploys',
      channelId: 1
    });
    expect(created!.channelId).toBe(1);
    expect(typeof created!.token).toBe('string');

    const fetched = await caller.webhooks.get({ webhookId: created!.id });
    expect(fetched?.id).toBe(created!.id);

    const listed = await caller.webhooks.list({ channelId: 1 });
    expect(listed.map((w) => w.id)).toContain(created!.id);

    const updated = await caller.webhooks.update({
      webhookId: created!.id,
      name: 'releases'
    });
    expect(updated!.name).toBe('releases');

    await caller.webhooks.delete({ webhookId: created!.id });
    expect(await caller.webhooks.get({ webhookId: created!.id })).toBeNull();
  });

  test('every route needs MANAGE_WEBHOOKS', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);

    const created = await owner.webhooks.create({ name: 'w', channelId: 1 });

    await expect(
      member.webhooks.create({ name: 'nope', channelId: 1 })
    ).rejects.toThrow('Insufficient permissions');
    await expect(member.webhooks.list({})).rejects.toThrow(
      'Insufficient permissions'
    );
    await expect(
      member.webhooks.get({ webhookId: created!.id })
    ).rejects.toThrow('Insufficient permissions');
    await expect(
      member.webhooks.update({ webhookId: created!.id, name: 'x' })
    ).rejects.toThrow('Insufficient permissions');
    await expect(
      member.webhooks.delete({ webhookId: created!.id })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('a webhook of another server is invisible and untouchable', async () => {
    const tdb = getTestDb();
    const { caller } = await initTest(1);
    const other = await insertOtherServer();
    const foreignChannel = await createTestChannel({ serverId: other.id });

    const [foreign] = await tdb
      .insert(webhooks)
      .values({
        name: 'foreign',
        channelId: foreignChannel,
        token: randomUUID(),
        createdBy: 1,
        serverId: other.id,
        createdAt: Date.now()
      })
      .returning();

    expect(await caller.webhooks.get({ webhookId: foreign!.id })).toBeNull();
    expect(
      await caller.webhooks.update({ webhookId: foreign!.id, name: 'hijack' })
    ).toBeUndefined();
    await caller.webhooks.delete({ webhookId: foreign!.id });

    const [still] = await tdb
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, foreign!.id));
    expect(still!.name).toBe('foreign');

    await expect(
      caller.webhooks.list({ channelId: foreignChannel })
    ).rejects.toThrow('Channel not found');
  });

  test('rejects non-positive and non-integer ids', async () => {
    const { caller } = await initTest(1);

    await expect(caller.webhooks.get({ webhookId: 0 })).rejects.toThrow();
    await expect(caller.webhooks.delete({ webhookId: -1 })).rejects.toThrow();
    await expect(
      caller.webhooks.list({ channelId: 1.5 })
    ).rejects.toThrow();
  });
});
