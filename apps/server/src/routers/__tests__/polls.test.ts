import { AutomodRuleType, ChannelPermission, ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createEmptyTextChannel,
  createTestChannel,
  createTestRole,
  grantTestUserRole,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { closeExpiredPollsTick } from '../../crons/polls';
import { channelUserPermissions, messages, polls, pollVotes } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import type { TPollUpdate } from '../../types';

/**
 * Polls: a 'poll' message plus a polls row with server-minted option
 * keys; votes fan out as POLL_UPDATE counts to the channel, the voter's
 * own choices come back on the vote routes only.
 */

type PublishCall = [number | number[], string, unknown];

const pollUpdates = (spy: { mock: { calls: unknown[][] } }) =>
  (spy.mock.calls as PublishCall[]).filter(([, t]) => t === ServerEvents.POLL_UPDATE);

/** The fan-out resolves its audience first; wait for it to land. */
const waitForUpdates = async (spy: { mock: { calls: unknown[][] } }, count: number) => {
  for (let i = 0; i < 200 && pollUpdates(spy).length < count; i++) await Bun.sleep(5);
  return pollUpdates(spy);
};

afterEach(() => {
  mock.restore();
});

const newPoll = async (
  caller: Awaited<ReturnType<typeof initTest>>['caller'],
  channelId: number,
  extra: Partial<{ multiple: boolean; anonymous: boolean; closesAt: number }> = {}
) =>
  caller.polls.create({
    channelId,
    question: 'Raid night?',
    options: ['Friday', 'Saturday', 'Sunday'],
    ...extra
  });

describe('polls.create', () => {
  test('creates a poll message with minted option keys and publishes it', async () => {
    const { caller } = await initTest(1);
    const channel = await createEmptyTextChannel('polls');
    const spy = spyOn(pubsub, 'publishFor');

    const view = await newPoll(caller, channel.id);

    expect(view.question).toBe('Raid night?');
    expect(view.options.map((o) => o.key)).toEqual(['o1', 'o2', 'o3']);
    expect(view.options.map((o) => o.label)).toEqual(['Friday', 'Saturday', 'Sunday']);
    expect(view.ownVotes).toEqual([]);
    expect(view.totalVoters).toBe(0);
    expect(view.closedAt).toBeNull();

    const [message] = await getTestDb().select().from(messages).where(eq(messages.id, view.messageId));
    expect(message!.type).toBe('poll');
    expect(message!.content).toBe('Raid night?');
    expect(message!.editable).toBe(false);

    for (let i = 0; i < 100 && !spy.mock.calls.some(([, t]) => t === ServerEvents.NEW_MESSAGE); i++) {
      await Bun.sleep(5);
    }
    const created = spy.mock.calls.find(([, t]) => t === ServerEvents.NEW_MESSAGE)!;
    expect((created[2] as { id: number }).id).toBe(view.messageId);
  });

  test('bounds: question, option count and length, duplicates, deadline window', async () => {
    const { caller } = await initTest(1);
    const channel = await createEmptyTextChannel('polls');
    const base = { channelId: channel.id, question: 'q', options: ['a', 'b'] };

    await expect(caller.polls.create({ ...base, question: 'x'.repeat(201) })).rejects.toThrow();
    await expect(caller.polls.create({ ...base, question: '   ' })).rejects.toThrow();
    await expect(caller.polls.create({ ...base, options: ['only'] })).rejects.toThrow();
    await expect(
      caller.polls.create({ ...base, options: Array.from({ length: 11 }, (_, i) => `o${i}`) })
    ).rejects.toThrow();
    await expect(caller.polls.create({ ...base, options: ['a', 'x'.repeat(81)] })).rejects.toThrow();
    await expect(caller.polls.create({ ...base, options: ['Same', 'same'] })).rejects.toThrow(
      'distinct'
    );
    await expect(caller.polls.create({ ...base, closesAt: Date.now() + 10_000 })).rejects.toThrow(
      'between one minute and 30 days'
    );
    await expect(
      caller.polls.create({ ...base, closesAt: Date.now() + 31 * 24 * 3600_000 })
    ).rejects.toThrow('between one minute and 30 days');

    const ok = await caller.polls.create({
      ...base,
      question: 'x'.repeat(200),
      options: Array.from({ length: 10 }, (_, i) => 'y'.repeat(80).slice(0, 79) + i),
      closesAt: Date.now() + 2 * 60_000
    });
    expect(ok.options).toHaveLength(10);
  });

  test('refused in voice and encrypted channels', async () => {
    const { caller } = await initTest(1);
    const voice = await createTestChannel({ serverId: 1, type: ChannelType.VOICE });
    const encrypted = await createTestChannel({ serverId: 1, e2ee: true });

    await expect(newPoll(caller, voice)).rejects.toThrow('Voice channels');
    await expect(newPoll(caller, encrypted)).rejects.toThrow('Encrypted channels');
  });

  test('automod runs over the question and the options', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const channel = await createEmptyTextChannel('polls');
    await owner.automod.createRule({
      name: 'no spoilers',
      type: AutomodRuleType.KEYWORD_FILTER,
      config: { keywords: ['spoiler'] },
      actions: [{ type: 'log' as const }]
    });

    await expect(
      member.polls.create({ channelId: channel.id, question: 'ok?', options: ['a', 'spoiler'] })
    ).rejects.toThrow('auto-moderation');
    expect(await getTestDb().select().from(polls)).toHaveLength(0);
  });

  test('a member without SEND_MESSAGES in the channel cannot create one', async () => {
    await initTest(1);
    const channel = await createEmptyTextChannel('polls');
    await getTestDb().insert(channelUserPermissions).values({
      channelId: channel.id,
      userId: 2,
      permission: ChannelPermission.SEND_MESSAGES,
      allow: false,
      createdAt: Date.now()
    });
    const { caller: member } = await initTest(2);

    await expect(newPoll(member, channel.id)).rejects.toThrow();
  });
});

describe('voting', () => {
  test('single choice: a second vote replaces the first; unvote clears it; counts fan out', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const channel = await createEmptyTextChannel('polls');
    const poll = await newPoll(owner, channel.id);
    const spy = spyOn(pubsub, 'publishFor');

    let view = await member.polls.vote({ pollId: poll.id, optionKey: 'o1' });
    expect(view.ownVotes).toEqual(['o1']);
    view = await member.polls.vote({ pollId: poll.id, optionKey: 'o2' });
    expect(view.ownVotes).toEqual(['o2']);
    expect(view.options.map((o) => o.votes)).toEqual([0, 1, 0]);
    expect(view.options[1]!.voterIds).toEqual([2]);
    expect(view.totalVoters).toBe(1);

    const updates = await waitForUpdates(spy, 2);
    const last = updates[updates.length - 1]![2] as TPollUpdate;
    expect(last.options.map((o) => o.votes)).toEqual([0, 1, 0]);
    expect((last as Record<string, unknown>).ownVotes).toBeUndefined();
    expect(updates[updates.length - 1]![0]).toContain(1);

    view = await member.polls.unvote({ pollId: poll.id, optionKey: 'o2' });
    expect(view.ownVotes).toEqual([]);
    expect(view.totalVoters).toBe(0);
    expect(await getTestDb().select().from(pollVotes)).toHaveLength(0);
  });

  test('multiple choice keeps every chosen option, once each', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const channel = await createEmptyTextChannel('polls');
    const poll = await newPoll(owner, channel.id, { multiple: true });

    await member.polls.vote({ pollId: poll.id, optionKey: 'o1' });
    await member.polls.vote({ pollId: poll.id, optionKey: 'o1' });
    const view = await member.polls.vote({ pollId: poll.id, optionKey: 'o3' });
    expect(view.ownVotes.sort()).toEqual(['o1', 'o3']);
    expect(view.options.map((o) => o.votes)).toEqual([1, 0, 1]);
    expect(view.totalVoters).toBe(1);
  });

  test('an anonymous poll counts but never lists voters', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const channel = await createEmptyTextChannel('polls');
    const poll = await newPoll(owner, channel.id, { anonymous: true });

    await member.polls.vote({ pollId: poll.id, optionKey: 'o1' });
    const view = await owner.polls.get({ messageId: poll.messageId });
    expect(view.options[0]!.votes).toBe(1);
    expect(view.options[0]!.voterIds).toEqual([]);
    expect(view.ownVotes).toEqual([]);
    expect((await member.polls.get({ messageId: poll.messageId })).ownVotes).toEqual(['o1']);
  });

  test('unknown option, closed poll and foreign server are refused', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await createEmptyTextChannel('polls');
    const poll = await newPoll(owner, channel.id);

    await expect(owner.polls.vote({ pollId: poll.id, optionKey: 'o9' })).rejects.toThrow(
      'Unknown poll option'
    );
    await expect(owner.polls.vote({ pollId: poll.id, optionKey: 'x'.repeat(9) })).rejects.toThrow();

    await owner.polls.close({ pollId: poll.id });
    await expect(owner.polls.vote({ pollId: poll.id, optionKey: 'o1' })).rejects.toThrow(
      'closed'
    );
    await expect(owner.polls.unvote({ pollId: poll.id, optionKey: 'o1' })).rejects.toThrow(
      'closed'
    );

    const other = await insertOtherServer();
    const foreignChannel = await createTestChannel({ serverId: other.id });
    const [foreignMessage] = await getTestDb()
      .insert(messages)
      .values({ channelId: foreignChannel, userId: 1, content: 'q', type: 'poll', createdAt: Date.now() })
      .returning();
    const [foreignPoll] = await getTestDb()
      .insert(polls)
      .values({
        messageId: foreignMessage!.id,
        channelId: foreignChannel,
        question: 'q',
        options: [{ key: 'o1', label: 'a' }, { key: 'o2', label: 'b' }],
        createdAt: Date.now()
      })
      .returning();

    await expect(owner.polls.vote({ pollId: foreignPoll!.id, optionKey: 'o1' })).rejects.toThrow(
      'Poll not found'
    );
    await expect(owner.polls.close({ pollId: foreignPoll!.id })).rejects.toThrow('Poll not found');
    await expect(owner.polls.get({ messageId: foreignMessage!.id })).rejects.toThrow(
      'Poll not found'
    );
  });

  test('a private channel the member cannot see hides its poll', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await createEmptyTextChannel('secret');
    await owner.channels.update({ channelId: channel.id, private: true });
    const poll = await newPoll(owner, channel.id);
    const { caller: member } = await initTest(2);

    await expect(member.polls.get({ messageId: poll.messageId })).rejects.toThrow();
    await expect(member.polls.vote({ pollId: poll.id, optionKey: 'o1' })).rejects.toThrow();
  });
});

describe('closing', () => {
  test('the author closes; another member needs MANAGE_MESSAGES; closing is idempotent', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const channel = await createEmptyTextChannel('polls');
    const poll = await newPoll(member, channel.id);

    const { caller: bystander } = await initTest(3);
    await expect(bystander.polls.close({ pollId: poll.id })).rejects.toThrow('permission');

    const spy = spyOn(pubsub, 'publishFor');
    const closed = await member.polls.close({ pollId: poll.id });
    expect(closed.closedAt).not.toBeNull();
    const again = await member.polls.close({ pollId: poll.id });
    expect(again.closedAt).toBe(closed.closedAt);
    await Bun.sleep(30);
    expect(pollUpdates(spy)).toHaveLength(1);

    // A moderator closes someone else's poll.
    const second = await newPoll(member, channel.id);
    const mod = await createTestRole({ serverId: 1, permissions: [Permission.MANAGE_MESSAGES] });
    await grantTestUserRole(3, mod);
    const { caller: moderator } = await initTest(3);
    expect((await moderator.polls.close({ pollId: second.id })).closedAt).not.toBeNull();
    expect((await owner.polls.get({ messageId: second.messageId })).closedAt).not.toBeNull();
  });

  test('the cron closes expired polls once and publishes', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await createEmptyTextChannel('polls');
    const expiring = await newPoll(owner, channel.id, { closesAt: Date.now() + 2 * 60_000 });
    const open = await newPoll(owner, channel.id);
    const spy = spyOn(pubsub, 'publishFor');

    expect(await closeExpiredPollsTick(Date.now())).toBe(0);

    const later = expiring.closesAt! + 1;
    expect(await closeExpiredPollsTick(later)).toBe(1);
    expect(await closeExpiredPollsTick(later + 60_000)).toBe(0);

    const [row] = await getTestDb().select().from(polls).where(eq(polls.id, expiring.id));
    expect(row!.closedAt).toBe(later);
    const [stillOpen] = await getTestDb().select().from(polls).where(eq(polls.id, open.id));
    expect(stillOpen!.closedAt).toBeNull();

    const updates = await waitForUpdates(spy, 1);
    expect((updates[0]![2] as TPollUpdate).id).toBe(expiring.id);
    expect(updates).toHaveLength(1);
  });

  test('deleting the message deletes the poll and its votes', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await createEmptyTextChannel('polls');
    const poll = await newPoll(owner, channel.id);
    await owner.polls.vote({ pollId: poll.id, optionKey: 'o1' });

    await owner.messages.delete({ messageId: poll.messageId });
    expect(await getTestDb().select().from(polls)).toHaveLength(0);
    expect(await getTestDb().select().from(pollVotes)).toHaveLength(0);
  });
});
