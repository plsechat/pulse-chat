import { AutomodRuleType, Permission, ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createEmptyTextChannel,
  createTestChannel,
  createTestRole,
  grantTestUserRole,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest, uploadFile } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { scheduledPostsTick } from '../../crons/scheduled-posts';
import {
  files,
  messageFiles,
  messages,
  scheduledPostFiles,
  scheduledPosts,
  serverMembers,
  userRoles
} from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

/**
 * Scheduled posts: a row the per-minute cron turns into a message AS
 * THE AUTHOR, through the send path's gates evaluated at send time.
 */

const MINUTE = 60_000;

type PublishCall = [number | number[], string, unknown];
const callsFor = (spy: { mock: { calls: unknown[][] } }, topic: string) =>
  (spy.mock.calls as PublishCall[]).filter(([, t]) => t === topic);
const waitFor = async (spy: { mock: { calls: unknown[][] } }, topic: string, count = 1) => {
  for (let i = 0; i < 200 && callsFor(spy, topic).length < count; i++) await Bun.sleep(5);
  return callsFor(spy, topic);
};

afterEach(() => {
  mock.restore();
});

describe('scheduled.create / list / cancel', () => {
  test('creates a pending row the author sees in the list', async () => {
    const { caller } = await initTest(2);
    const channel = await createEmptyTextChannel('plans');
    const sendAt = Date.now() + 10 * MINUTE;
    const spy = spyOn(pubsub, 'publishFor');

    const id = await caller.scheduled.create({ channelId: channel.id, content: 'later', sendAt });
    expect(id).toBeGreaterThan(0);

    const list = await caller.scheduled.list({ channelId: channel.id });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, channelId: channel.id, userId: 2, content: 'later', sendAt, files: [] });

    const pings = await waitFor(spy, ServerEvents.SCHEDULED_POST_UPDATE);
    expect(pings[0]![2]).toEqual({ channelId: channel.id });
  });

  test('bounds: window, content, encrypted channel, pending cap', async () => {
    const { caller } = await initTest(1);
    const channel = await createEmptyTextChannel('plans');
    const encrypted = await createTestChannel({ serverId: 1, e2ee: true });
    const base = { channelId: channel.id, content: 'x' };

    await expect(caller.scheduled.create({ ...base, sendAt: Date.now() + MINUTE })).rejects.toThrow(
      'between 2 minutes and 30 days'
    );
    await expect(
      caller.scheduled.create({ ...base, sendAt: Date.now() + 31 * 24 * 60 * MINUTE })
    ).rejects.toThrow('between 2 minutes and 30 days');
    await expect(
      caller.scheduled.create({ channelId: channel.id, content: '   ', sendAt: Date.now() + 5 * MINUTE })
    ).rejects.toThrow('needs content or files');
    await expect(
      caller.scheduled.create({ ...base, content: 'x'.repeat(16001), sendAt: Date.now() + 5 * MINUTE })
    ).rejects.toThrow();
    await expect(
      caller.scheduled.create({ channelId: encrypted, content: 'x', sendAt: Date.now() + 5 * MINUTE })
    ).rejects.toThrow('Encrypted channels');
    await expect(
      caller.scheduled.create({
        ...base,
        sendAt: Date.now() + 5 * MINUTE,
        files: Array.from({ length: 11 }, (_, i) => `f${i}`)
      })
    ).rejects.toThrow();

    for (let i = 0; i < 50; i++) {
      await caller.scheduled.create({ ...base, sendAt: Date.now() + 5 * MINUTE });
    }
    await expect(caller.scheduled.create({ ...base, sendAt: Date.now() + 5 * MINUTE })).rejects.toThrow(
      'already have 50'
    );
  });

  test('automod refuses at schedule time with the rule\'s actions', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const channel = await createEmptyTextChannel('plans');
    await owner.automod.createRule({
      name: 'no spoilers',
      type: AutomodRuleType.KEYWORD_FILTER,
      config: { keywords: ['spoiler'] },
      actions: [{ type: 'log' as const }]
    });

    await expect(
      member.scheduled.create({ channelId: channel.id, content: 'a spoiler', sendAt: Date.now() + 5 * MINUTE })
    ).rejects.toThrow('auto-moderation');
    expect(await getTestDb().select().from(scheduledPosts)).toHaveLength(0);
  });

  test('visibility: the author sees own rows, a moderator everyone\'s, a bystander none', async () => {
    const { caller: author } = await initTest(2);
    const channel = await createEmptyTextChannel('plans');
    await author.scheduled.create({ channelId: channel.id, content: 'mine', sendAt: Date.now() + 5 * MINUTE });

    const { caller: bystander } = await initTest(3);
    expect(await bystander.scheduled.list({ channelId: channel.id })).toEqual([]);

    const { caller: owner } = await initTest(1);
    await owner.scheduled.create({ channelId: channel.id, content: 'owner', sendAt: Date.now() + 6 * MINUTE });
    expect((await owner.scheduled.list({ channelId: channel.id })).map((p) => p.content)).toEqual([
      'mine',
      'owner'
    ]);
    expect((await author.scheduled.list({ channelId: channel.id })).map((p) => p.content)).toEqual(['mine']);
  });

  test('cancel: the author or MANAGE_MESSAGES; files go with it; a repeat is a no-op', async () => {
    const { caller: author, mockedToken } = await initTest(2);
    const channel = await createEmptyTextChannel('plans');
    const upload = await uploadFile(new File(['hello'], 'notes.txt', { type: 'text/plain' }), mockedToken);
    const { id: tempId } = (await upload.json()) as { id: string };

    const id = await author.scheduled.create({
      channelId: channel.id,
      content: 'with file',
      sendAt: Date.now() + 5 * MINUTE,
      files: [tempId]
    });
    const listed = await author.scheduled.list({ channelId: channel.id });
    expect(listed[0]!.files).toHaveLength(1);
    expect(listed[0]!.files[0]!.originalName).toBe('notes.txt');
    expect(await getTestDb().select().from(scheduledPostFiles)).toHaveLength(1);

    const { caller: bystander } = await initTest(3);
    await expect(bystander.scheduled.cancel({ scheduledPostId: id })).rejects.toThrow('permission');

    expect(await author.scheduled.cancel({ scheduledPostId: id })).toEqual({ cancelled: true });
    expect(await author.scheduled.list({ channelId: channel.id })).toEqual([]);
    expect(await getTestDb().select().from(scheduledPostFiles)).toHaveLength(0);
    expect(await getTestDb().select().from(files)).toHaveLength(0);
    expect(await author.scheduled.cancel({ scheduledPostId: id })).toEqual({ cancelled: false });

    const second = await author.scheduled.create({ channelId: channel.id, content: 'two', sendAt: Date.now() + 5 * MINUTE });
    const { caller: owner } = await initTest(1);
    expect(await owner.scheduled.cancel({ scheduledPostId: second })).toEqual({ cancelled: true });
  });

  test('rows of another server are not found', async () => {
    const { caller: owner } = await initTest(1);
    const other = await insertOtherServer();
    const foreign = await createTestChannel({ serverId: other.id });
    const [row] = await getTestDb()
      .insert(scheduledPosts)
      .values({ channelId: foreign, userId: 1, content: 'x', sendAt: Date.now(), createdAt: Date.now() })
      .returning();

    await expect(owner.scheduled.cancel({ scheduledPostId: row!.id })).rejects.toThrow('not found');
    await expect(owner.scheduled.list({ channelId: foreign })).rejects.toThrow('Channel not found');
  });
});

describe('scheduled sender cron', () => {
  test('posts a due row as its author with mentions, files, fan-out and the sent link', async () => {
    const { caller: author, mockedToken } = await initTest(2);
    const channel = await createEmptyTextChannel('plans');
    const upload = await uploadFile(new File(['hello'], 'notes.txt', { type: 'text/plain' }), mockedToken);
    const { id: tempId } = (await upload.json()) as { id: string };
    const sendAt = Date.now() + 3 * MINUTE;
    const id = await author.scheduled.create({
      channelId: channel.id,
      content: 'hello <@1> it is time',
      sendAt,
      files: [tempId]
    });
    const spy = spyOn(pubsub, 'publishFor');

    // Not due yet.
    expect(await scheduledPostsTick(sendAt - 1)).toBe(0);
    expect(await getTestDb().select().from(messages).where(eq(messages.channelId, channel.id))).toHaveLength(0);

    expect(await scheduledPostsTick(sendAt)).toBe(1);
    const [posted] = await getTestDb().select().from(messages).where(eq(messages.channelId, channel.id));
    expect(posted).toMatchObject({
      userId: 2,
      content: 'hello <@1> it is time',
      type: 'user',
      editable: true,
      createdAt: sendAt,
      mentionedUserIds: [1]
    });

    const [row] = await getTestDb().select().from(scheduledPosts).where(eq(scheduledPosts.id, id));
    expect(row!.sentMessageId).toBe(posted!.id);
    expect(await getTestDb().select().from(scheduledPostFiles)).toHaveLength(0);
    const attached = await getTestDb().select().from(messageFiles).where(eq(messageFiles.messageId, posted!.id));
    expect(attached).toHaveLength(1);

    const created = await waitFor(spy, ServerEvents.NEW_MESSAGE);
    expect((created[0]![2] as { id: number; userId: number }).userId).toBe(2);
    expect(created[0]![0]).toContain(1);
    await waitFor(spy, ServerEvents.SCHEDULED_POST_UPDATE);

    // Sent rows leave the list and a second tick does nothing.
    expect(await author.scheduled.list({ channelId: channel.id })).toEqual([]);
    expect(await scheduledPostsTick(sendAt + MINUTE)).toBe(0);
    expect(await getTestDb().select().from(messages).where(eq(messages.channelId, channel.id))).toHaveLength(1);
  });

  test('automod runs at send time: a rule added after scheduling blocks the row and cancels it', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: author } = await initTest(2);
    const channel = await createEmptyTextChannel('plans');
    const sendAt = Date.now() + 3 * MINUTE;
    const id = await author.scheduled.create({ channelId: channel.id, content: 'a spoiler', sendAt });
    await owner.automod.createRule({
      name: 'no spoilers',
      type: AutomodRuleType.KEYWORD_FILTER,
      config: { keywords: ['spoiler'] },
      actions: [{ type: 'log' as const }]
    });

    expect(await scheduledPostsTick(sendAt)).toBe(0);
    expect(await getTestDb().select().from(messages).where(eq(messages.channelId, channel.id))).toHaveLength(0);
    const [row] = await getTestDb().select().from(scheduledPosts).where(eq(scheduledPosts.id, id));
    expect(row!.cancelledAt).toBe(sendAt);
    expect(row!.sentMessageId).toBeNull();
  });

  test('an author who left, lost SEND_MESSAGES or the announcer role is not posted for', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: author } = await initTest(2);
    const tdb = getTestDb();
    const plans = await createEmptyTextChannel('plans');
    const sendAt = Date.now() + 3 * MINUTE;

    // Announcement channel: the author schedules while holding the role,
    // then loses it.
    const news = await createEmptyTextChannel('news');
    await owner.channels.update({ channelId: news.id, announcement: true });
    const role = await createTestRole({ serverId: 1, permissions: [Permission.MANAGE_ANNOUNCEMENTS] });
    await grantTestUserRole(2, role);
    const { caller: announcer } = await initTest(2);
    const announcement = await announcer.scheduled.create({ channelId: news.id, content: 'news', sendAt });
    await tdb.delete(userRoles).where(eq(userRoles.roleId, role));

    // Plain channel: the author leaves the server.
    const plain = await author.scheduled.create({ channelId: plans.id, content: 'bye', sendAt });
    await tdb.delete(serverMembers).where(eq(serverMembers.userId, 2));

    expect(await scheduledPostsTick(sendAt)).toBe(0);
    expect(await tdb.select().from(messages).where(eq(messages.channelId, news.id))).toHaveLength(0);
    expect(await tdb.select().from(messages).where(eq(messages.channelId, plans.id))).toHaveLength(0);
    for (const id of [announcement, plain]) {
      const [row] = await tdb.select().from(scheduledPosts).where(eq(scheduledPosts.id, id));
      expect(row!.cancelledAt).toBe(sendAt);
    }
  });

  test('a timed-out author waits; the owner is never locked out', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: author } = await initTest(2);
    const tdb = getTestDb();
    const channel = await createEmptyTextChannel('plans');
    const sendAt = Date.now() + 3 * MINUTE;
    const id = await author.scheduled.create({ channelId: channel.id, content: 'x', sendAt });
    const own = await owner.scheduled.create({ channelId: channel.id, content: 'o', sendAt });
    await tdb
      .update(serverMembers)
      .set({ timedOutUntil: Date.now() + 60 * MINUTE })
      .where(eq(serverMembers.userId, 2));

    expect(await scheduledPostsTick(sendAt)).toBe(1);
    const [row] = await tdb.select().from(scheduledPosts).where(eq(scheduledPosts.id, id));
    expect(row!.cancelledAt).toBe(sendAt);
    const [ownRow] = await tdb.select().from(scheduledPosts).where(eq(scheduledPosts.id, own));
    expect(ownRow!.sentMessageId).not.toBeNull();
  });

  test('a cancel that lands before the tick wins; finished rows are pruned after a day', async () => {
    const { caller: author } = await initTest(2);
    const tdb = getTestDb();
    const channel = await createEmptyTextChannel('plans');
    const sendAt = Date.now() + 3 * MINUTE;
    const id = await author.scheduled.create({ channelId: channel.id, content: 'x', sendAt });
    await author.scheduled.cancel({ scheduledPostId: id });

    expect(await scheduledPostsTick(sendAt)).toBe(0);
    expect(await tdb.select().from(messages).where(eq(messages.channelId, channel.id))).toHaveLength(0);

    expect(await tdb.select().from(scheduledPosts)).toHaveLength(1);
    await scheduledPostsTick(sendAt + 25 * 60 * MINUTE);
    expect(await tdb.select().from(scheduledPosts)).toHaveLength(0);
  });
});
