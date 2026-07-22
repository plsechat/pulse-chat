/**
 * Report flow, layered: participant-gated reports.create with
 * create-time routing (server mod queue vs instance operator), the
 * server mod queue (reports.listServerQueue / resolveServer), the
 * operator queue + receipts (admin.listReports / resolveReport), and
 * stale escalation. Setup is done inline in each test (no beforeEach)
 * to avoid piling row inserts onto the global setup.ts TRUNCATE in a
 * way that competes with parallel test files for table-level locks.
 *
 * Fixture facts: user 1 is the instance owner AND server 1's owner
 * (bootstrap), users 2/3 are plain members of server 1.
 */

import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { escalateStaleReports } from '../../db/queries/reports';
import {
  dmChannelMembers,
  dmChannels,
  dmMessages,
  messages,
  reports,
  serverMembers,
  users
} from '../../db/schema';
import { initTest } from '../../__tests__/helpers';

const insertChannelMessage = async (
  userId: number,
  content: string,
  e2ee = false
) => {
  const [msg] = await db
    .insert(messages)
    .values({ content, userId, channelId: 1, e2ee, createdAt: Date.now() })
    .returning();
  return msg!;
};

const insertDm = async (memberIds: number[]) => {
  const [channel] = await db
    .insert(dmChannels)
    .values({ createdAt: Date.now() })
    .returning();
  for (const userId of memberIds) {
    await db.insert(dmChannelMembers).values({
      dmChannelId: channel!.id,
      userId,
      createdAt: Date.now()
    });
  }
  return channel!;
};

const reportRowFor = async (messageId: number) => {
  const [row] = await db
    .select()
    .from(reports)
    .where(eq(reports.targetMessageId, messageId));
  return row;
};

describe('reports.create routing', () => {
  test('plain channel report lands in the server mod queue with a server-verified snapshot', async () => {
    const { caller } = await initTest(2);
    const msg = await insertChannelMessage(3, `bad content ${randomUUIDv7()}`);

    await caller.reports.create({
      kind: 'message',
      targetId: msg.id,
      reason: 'harassment',
      details: 'seen in general'
    });

    const row = await reportRowFor(msg.id);
    expect(row).toBeDefined();
    expect(row!.targetUserId).toBe(3);
    expect(row!.reporterId).toBe(2);
    expect(row!.serverId).toBe(1);
    expect(row!.status).toBe('open');
    expect(row!.audience).toBe('server');
    expect(row!.escalationReason).toBeNull();
    // Plaintext target: the snapshot is the SERVER's copy, not
    // reporter-supplied.
    expect(row!.contentSnapshot).toBe(msg.content);
    expect(row!.snapshotAttested).toBe(false);
  });

  test("reason 'illegal' escalates to the operator at create time", async () => {
    const { caller } = await initTest(2);
    const msg = await insertChannelMessage(3, `illegal ${randomUUIDv7()}`);

    await caller.reports.create({
      kind: 'message',
      targetId: msg.id,
      reason: 'illegal'
    });

    const row = await reportRowFor(msg.id);
    expect(row!.audience).toBe('instance');
    expect(row!.escalationReason).toBe('illegal');
    expect(row!.escalatedAt).not.toBeNull();
  });

  test('reporting the server owner skips the queue the owner can read', async () => {
    const { caller } = await initTest(2);
    const msg = await insertChannelMessage(1, `mod content ${randomUUIDv7()}`);

    await caller.reports.create({
      kind: 'message',
      targetId: msg.id,
      reason: 'spam'
    });

    const row = await reportRowFor(msg.id);
    expect(row!.audience).toBe('instance');
    expect(row!.escalationReason).toBe('target_mod');
  });

  test('E2EE target: reporter-attested snapshot, flagged as such', async () => {
    const { caller } = await initTest(2);
    const msg = await insertChannelMessage(
      3,
      `ciphertext-${randomUUIDv7()}`,
      true
    );

    await caller.reports.create({
      kind: 'message',
      targetId: msg.id,
      reason: 'harassment',
      decryptedContent: 'what the reporter saw on screen'
    });

    const row = await reportRowFor(msg.id);
    expect(row!.contentSnapshot).toBe('what the reporter saw on screen');
    expect(row!.snapshotAttested).toBe(true);
  });

  test('duplicate open report and self-report are refused', async () => {
    const { caller } = await initTest(2);
    const msg = await insertChannelMessage(3, `dup ${randomUUIDv7()}`);

    await caller.reports.create({
      kind: 'message',
      targetId: msg.id,
      reason: 'spam'
    });
    await expect(
      caller.reports.create({ kind: 'message', targetId: msg.id, reason: 'spam' })
    ).rejects.toThrow('already have an open report');

    const own = await insertChannelMessage(2, `own ${randomUUIDv7()}`);
    await expect(
      caller.reports.create({ kind: 'message', targetId: own.id, reason: 'spam' })
    ).rejects.toThrow('cannot report yourself');
  });

  test('DM message: participant can report (routed to the operator), outsider cannot', async () => {
    const { caller: participant } = await initTest(2);
    const dm = await insertDm([2, 3]);
    const [dmMsg] = await db
      .insert(dmMessages)
      .values({
        content: `dm bad ${randomUUIDv7()}`,
        userId: 3,
        dmChannelId: dm.id,
        createdAt: Date.now()
      })
      .returning();

    // User 1 is not in this DM — identical shape to nonexistent.
    const { caller: outsider } = await initTest(1);
    await expect(
      outsider.reports.create({
        kind: 'dm_message',
        targetId: dmMsg!.id,
        reason: 'harassment'
      })
    ).rejects.toThrow('Message not found');

    await participant.reports.create({
      kind: 'dm_message',
      targetId: dmMsg!.id,
      reason: 'harassment'
    });
    const [row] = await db
      .select()
      .from(reports)
      .where(eq(reports.targetDmMessageId, dmMsg!.id));
    expect(row!.contentSnapshot).toBe(dmMsg!.content);
    expect(row!.serverId).toBeNull();
    // No server-level reviewer exists for a DM.
    expect(row!.audience).toBe('instance');
    expect(row!.escalationReason).toBeNull();
  });

  test('report volume is bounded per reporter', async () => {
    const { caller } = await initTest(2);

    // Pre-fill the 10-minute window to the cap directly.
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await db.insert(reports).values({
        kind: 'user',
        targetUserId: 3,
        reporterId: 2,
        reason: 'spam',
        audience: 'instance',
        status: 'dismissed',
        createdAt: now - 1000 - i
      });
    }

    const msg = await insertChannelMessage(3, `flood ${randomUUIDv7()}`);
    await expect(
      caller.reports.create({ kind: 'message', targetId: msg.id, reason: 'spam' })
    ).rejects.toThrow('Too many reports');
  });
});

describe('server mod queue', () => {
  test('listServerQueue needs VIEW_REPORTS (owner bypasses) and sees only server-audience rows', async () => {
    const { caller: member } = await initTest(2);
    const plain = await insertChannelMessage(3, `queue ${randomUUIDv7()}`);
    const illegal = await insertChannelMessage(3, `hot ${randomUUIDv7()}`);
    await member.reports.create({
      kind: 'message',
      targetId: plain.id,
      reason: 'spam'
    });
    await member.reports.create({
      kind: 'message',
      targetId: illegal.id,
      reason: 'illegal'
    });

    // Plain member: no VIEW_REPORTS role, not the owner.
    await expect(member.reports.listServerQueue({})).rejects.toThrow(
      'Insufficient permissions'
    );

    // The queue must carry the identity triple — mods know members by
    // nickname, but bans hit the account.
    await db
      .update(serverMembers)
      .set({ nickname: 'NickInServer' })
      .where(eq(serverMembers.userId, 3));

    const { caller: owner } = await initTest(1);
    const { reports: queue } = await owner.reports.listServerQueue({});
    const entry = queue.find((r) => r.targetMessageId === plain.id);
    expect(entry).toBeDefined();
    expect(entry!.targetNickname).toBe('NickInServer');
    expect(entry!.targetPublicId.length).toBeGreaterThan(0);
    // The illegal one went straight to the operator.
    expect(queue.find((r) => r.targetMessageId === illegal.id)).toBeUndefined();
  });

  test('resolveServer delete-and-kick takes the message down and removes the author', async () => {
    const { caller: member } = await initTest(2);
    // Ensure the author actually holds a membership to be kicked from.
    await initTest(3);
    const msg = await insertChannelMessage(3, `kickable ${randomUUIDv7()}`);
    await member.reports.create({
      kind: 'message',
      targetId: msg.id,
      reason: 'harassment'
    });
    const report = await reportRowFor(msg.id);

    const { caller: owner } = await initTest(1);
    await owner.reports.resolveServer({
      reportId: report!.id,
      action: 'delete-and-kick'
    });

    const [gone] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, msg.id));
    expect(gone).toBeUndefined();

    const [membership] = await db
      .select()
      .from(serverMembers)
      .where(eq(serverMembers.userId, 3));
    expect(membership).toBeUndefined();

    const [after] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, report!.id));
    expect(after!.status).toBe('resolved');
    expect(after!.resolvedBy).toBe(1);
  });

  test('escalate hands the open report to the operator and leaves the mod queue', async () => {
    const { caller: member } = await initTest(2);
    const msg = await insertChannelMessage(3, `escalate ${randomUUIDv7()}`);
    await member.reports.create({
      kind: 'message',
      targetId: msg.id,
      reason: 'other'
    });
    const report = await reportRowFor(msg.id);

    const { caller: owner } = await initTest(1);
    await owner.reports.resolveServer({
      reportId: report!.id,
      action: 'escalate'
    });

    const [after] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, report!.id));
    expect(after!.status).toBe('open');
    expect(after!.audience).toBe('instance');
    expect(after!.escalationReason).toBe('manual');
    expect(after!.escalatedBy).toBe(1);

    const { reports: queue } = await owner.reports.listServerQueue({});
    expect(queue.find((r) => r.id === report!.id)).toBeUndefined();

    const { reports: operatorQueue } = await owner.admin.listReports({});
    expect(operatorQueue.find((r) => r.id === report!.id)).toBeDefined();

    // Already escalated: a second server-side resolution reads as gone.
    await expect(
      owner.reports.resolveServer({ reportId: report!.id, action: 'dismiss' })
    ).rejects.toThrow('Report not found');
  });

  test('a mod cannot resolve a report about themselves', async () => {
    // Roles can change after create-time routing ran — seed the state
    // directly: a server-audience report whose target IS the resolver.
    const msg = await insertChannelMessage(1, `self ${randomUUIDv7()}`);
    const [seeded] = await db
      .insert(reports)
      .values({
        kind: 'message',
        targetUserId: 1,
        targetMessageId: msg.id,
        serverId: 1,
        reporterId: 2,
        reason: 'spam',
        audience: 'server',
        createdAt: Date.now()
      })
      .returning({ id: reports.id });

    const { caller: owner } = await initTest(1);
    await expect(
      owner.reports.resolveServer({
        reportId: seeded!.id,
        action: 'delete-content'
      })
    ).rejects.toThrow('about yourself');
  });

  test('stale open server reports escalate; fresh and closed ones stay', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const mk = (over: Partial<typeof reports.$inferInsert>) =>
      db
        .insert(reports)
        .values({
          kind: 'message',
          targetUserId: 3,
          serverId: 1,
          reporterId: 2,
          reason: 'spam',
          audience: 'server',
          createdAt: Date.now(),
          ...over
        })
        .returning({ id: reports.id })
        .then(([r]) => r!.id);

    const staleId = await mk({ createdAt: eightDaysAgo });
    const freshId = await mk({});
    const closedId = await mk({ createdAt: eightDaysAgo, status: 'dismissed' });

    const moved = await escalateStaleReports();
    expect(moved).toContain(staleId);
    expect(moved).not.toContain(freshId);
    expect(moved).not.toContain(closedId);

    const [stale] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, staleId));
    expect(stale!.audience).toBe('instance');
    expect(stale!.escalationReason).toBe('stale');
    expect(stale!.status).toBe('open');
  });
});

describe('operator queue + receipts', () => {
  test('listReports is owner-only; server-audience rows appear as receipts with the snapshot', async () => {
    const { caller: member } = await initTest(2);
    const msg = await insertChannelMessage(3, `receipt ${randomUUIDv7()}`);
    await member.reports.create({
      kind: 'message',
      targetId: msg.id,
      reason: 'harassment'
    });

    await expect(member.admin.listReports({})).rejects.toThrow(
      'Only the instance owner'
    );

    const { caller: owner } = await initTest(1);
    // Server-audience report: NOT in the operator's actionable queue...
    const { reports: queue } = await owner.admin.listReports({});
    expect(queue.find((r) => r.targetMessageId === msg.id)).toBeUndefined();
    // ...but fully visible (snapshot included) as a receipt.
    const { reports: receipts } = await owner.admin.listReports({
      audience: 'server'
    });
    const entry = receipts.find((r) => r.targetMessageId === msg.id);
    expect(entry).toBeDefined();
    expect(entry!.contentSnapshot).toBe(msg.content);
    expect(typeof entry!.reporterName).toBe('string');
    expect(typeof entry!.targetName).toBe('string');
  });

  test('dismiss closes the report and touches nothing else', async () => {
    const { caller: member } = await initTest(2);
    const msg = await insertChannelMessage(3, `dismiss ${randomUUIDv7()}`);
    await member.reports.create({
      kind: 'message',
      targetId: msg.id,
      reason: 'other'
    });
    const report = await reportRowFor(msg.id);

    // Operator override: acting directly on a server-audience receipt.
    const { caller: owner } = await initTest(1);
    await owner.admin.resolveReport({ reportId: report!.id, action: 'dismiss' });

    const [after] = await db
      .select()
      .from(reports)
      .where(eq(reports.id, report!.id));
    expect(after!.status).toBe('dismissed');
    expect(after!.resolvedBy).toBe(1);

    // The message survives a dismissal.
    const [stillThere] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, msg.id));
    expect(stillThere).toBeDefined();

    await expect(
      owner.admin.resolveReport({ reportId: report!.id, action: 'dismiss' })
    ).rejects.toThrow('already resolved');
  });

  test('delete-content removes the message; delete-and-ban also bans the author', async () => {
    const { caller: member } = await initTest(2);
    const msg = await insertChannelMessage(3, `takedown ${randomUUIDv7()}`);
    await member.reports.create({
      kind: 'message',
      targetId: msg.id,
      reason: 'illegal'
    });
    const report = await reportRowFor(msg.id);

    const { caller: owner } = await initTest(1);
    await owner.admin.resolveReport({
      reportId: report!.id,
      action: 'delete-and-ban'
    });

    const [gone] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, msg.id));
    expect(gone).toBeUndefined();

    const [author] = await db
      .select({ banned: users.banned, banReason: users.banReason })
      .from(users)
      .where(eq(users.id, 3));
    expect(author!.banned).toBe(true);
    expect(author!.banReason).toContain(`Report #${report!.id}`);

    const [after] = await db
      .select({ status: reports.status })
      .from(reports)
      .where(eq(reports.id, report!.id));
    expect(after!.status).toBe('resolved');

    // Restore user 3 for parallel files.
    await db
      .update(users)
      .set({ banned: false, banReason: null })
      .where(eq(users.id, 3));
    const { markUnbanned } = await import('../../utils/banned-cache');
    markUnbanned(3);
  });
});
