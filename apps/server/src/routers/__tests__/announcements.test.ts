import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createEmptyTextChannel,
  createTestChannel,
  createTestRole,
  grantTestUserRole
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { channels, messages } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

/**
 * Announcement channels: a TEXT channel flagged by MANAGE_CHANNELS in
 * which only MANAGE_ANNOUNCEMENTS holders post — through every path
 * that creates a message row (send, poll, schedule) — while everyone
 * reads, reacts and opens threads.
 */

const GATE = 'Only announcers can post here';

afterEach(() => {
  mock.restore();
});

const flagged = async (name = 'news') => {
  const { caller: owner } = await initTest(1);
  const channel = await createEmptyTextChannel(name);
  await owner.channels.update({ channelId: channel.id, announcement: true });
  return { owner, channel };
};

describe('announcement flag', () => {
  test('MANAGE_CHANNELS flags a text channel and the flag is on the wire', async () => {
    const { owner, channel } = await flagged();

    const wire = await owner.channels.get({ channelId: channel.id });
    expect(wire.announcement).toBe(true);

    await owner.channels.update({ channelId: channel.id, announcement: false });
    expect((await owner.channels.get({ channelId: channel.id })).announcement).toBe(false);
  });

  test('a plain member cannot flag a channel', async () => {
    const { caller: member } = await initTest(2);
    const channel = await createEmptyTextChannel('news');

    await expect(
      member.channels.update({ channelId: channel.id, announcement: true })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('voice and encrypted channels cannot be announcement channels, and the reverse', async () => {
    const { caller: owner } = await initTest(1);
    const voice = await createTestChannel({ serverId: 1, type: ChannelType.VOICE });
    const encrypted = await createTestChannel({ serverId: 1, e2ee: true });

    await expect(
      owner.channels.update({ channelId: voice, announcement: true })
    ).rejects.toThrow('Only text channels');
    await expect(
      owner.channels.update({ channelId: encrypted, announcement: true })
    ).rejects.toThrow('Encrypted channels cannot be announcement channels');

    const news = await createEmptyTextChannel('news');
    await owner.channels.update({ channelId: news.id, announcement: true });
    await expect(
      owner.channels.update({ channelId: news.id, e2ee: true })
    ).rejects.toThrow('Announcement channels cannot be encrypted');
    // Both in one call is refused too — order must not matter.
    await expect(
      owner.channels.update({ channelId: news.id, announcement: true, e2ee: true })
    ).rejects.toThrow();
  });
});

describe('posting gate', () => {
  test('a member without MANAGE_ANNOUNCEMENTS cannot send, poll or schedule; the owner can', async () => {
    const { owner, channel } = await flagged();
    const { caller: member } = await initTest(2);

    await expect(
      member.messages.send({ channelId: channel.id, content: 'hi' })
    ).rejects.toThrow(GATE);
    await expect(
      member.polls.create({ channelId: channel.id, question: 'q', options: ['a', 'b'] })
    ).rejects.toThrow(GATE);
    await expect(
      member.scheduled.create({
        channelId: channel.id,
        content: 'later',
        sendAt: Date.now() + 10 * 60_000
      })
    ).rejects.toThrow(GATE);

    const id = await owner.messages.send({ channelId: channel.id, content: 'release notes' });
    expect(id).toBeGreaterThan(0);
    expect(await getTestDb().select().from(messages).where(eq(messages.channelId, channel.id))).toHaveLength(1);
  });

  test('a MANAGE_ANNOUNCEMENTS role unlocks posting', async () => {
    const { channel } = await flagged();
    const role = await createTestRole({
      serverId: 1,
      name: 'Announcer',
      permissions: [Permission.MANAGE_ANNOUNCEMENTS]
    });
    await grantTestUserRole(3, role);
    const { caller: announcer } = await initTest(3);

    const id = await announcer.messages.send({ channelId: channel.id, content: 'patch day' });
    expect(id).toBeGreaterThan(0);
    const poll = await announcer.polls.create({
      channelId: channel.id,
      question: 'When?',
      options: ['Now', 'Later']
    });
    expect(poll.options).toHaveLength(2);
  });

  test('everyone still reads and reacts, and a thread under it is open to all', async () => {
    const { owner, channel } = await flagged();
    const { caller: member } = await initTest(2);
    const spy = spyOn(pubsub, 'publishFor');

    const id = await owner.messages.send({ channelId: channel.id, content: 'big news' });
    // The member receives the row like any channel message …
    for (let i = 0; i < 100 && !spy.mock.calls.some(([, t]) => t === ServerEvents.NEW_MESSAGE); i++) {
      await Bun.sleep(5);
    }
    const fanout = spy.mock.calls.find(([, t]) => t === ServerEvents.NEW_MESSAGE)!;
    expect(fanout[0]).toContain(2);

    // … reads it and reacts to it.
    const { messages: listed } = await member.messages.get({ channelId: channel.id });
    expect(listed.map((m) => m.id)).toContain(id);
    await member.messages.toggleReaction({ messageId: id, emoji: '👍' });

    // A thread is its own channel row with the flag off: the member posts there.
    const { threadId } = await owner.threads.create({ messageId: id, name: 'discussion' });
    const [threadRow] = await getTestDb()
      .select({ announcement: channels.announcement })
      .from(channels)
      .where(eq(channels.id, threadId));
    expect(threadRow!.announcement).toBe(false);
    const reply = await member.messages.send({ channelId: threadId, content: 'nice' });
    expect(reply).toBeGreaterThan(0);
  });

  test('the flag is scoped to the active server', async () => {
    const { caller: owner } = await initTest(1);
    const { insertOtherServer } = await import('../../__tests__/fixtures');
    const other = await insertOtherServer();
    const foreign = await createTestChannel({ serverId: other.id });

    await expect(
      owner.channels.update({ channelId: foreign, announcement: true })
    ).rejects.toThrow('Channel not found');
  });
});
