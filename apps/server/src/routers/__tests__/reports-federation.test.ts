/**
 * reports.create against a federated (shadow) target also queues a
 * `/federation/report-user` relay to the target's home instance. The
 * fetch spy answers 503 so the row stays in the outbox and its payload
 * can be asserted; the local report row is created either way.
 *
 * Fixture facts: user 2 is a plain member of server 1. Setup inline.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  dmChannelMembers,
  dmChannels,
  dmMessages,
  federationOutbox,
  reports,
  users
} from '../../db/schema';
import {
  mockDns,
  seedPeerInstance,
  spyOnFetch
} from '../../__tests__/federation-fixtures';
import { initTest, waitUntil } from '../../__tests__/helpers';
import { generateFederationKeys } from '../../utils/federation';

const PEER_DOMAIN = 'home.reports.example.com';

afterEach(() => {
  mock.restore();
});

const unavailable = () =>
  new Response(JSON.stringify({ error: 'down' }), { status: 503 });

/** Shadow of a peer user sharing a 1:1 DM with local user 2. */
async function seedShadowInDmWith(userId: number) {
  const instanceId = await seedPeerInstance(PEER_DOMAIN);
  const [shadow] = await db
    .insert(users)
    .values({
      supabaseId: 'report-shadow',
      name: 'Shadow',
      publicId: 'report-shadow-local-pid',
      isFederated: true,
      federatedInstanceId: instanceId,
      federatedPublicId: 'report-shadow-home-pid',
      createdAt: Date.now()
    })
    .returning();
  const [channel] = await db
    .insert(dmChannels)
    .values({ isGroup: false, e2ee: false, createdAt: Date.now() })
    .returning();
  await db.insert(dmChannelMembers).values([
    { dmChannelId: channel!.id, userId, createdAt: Date.now() },
    { dmChannelId: channel!.id, userId: shadow!.id, createdAt: Date.now() }
  ]);
  return { shadowId: shadow!.id, channelId: channel!.id };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('reports.create federated target', () => {
  test('a user report on a shadow queues one report-user relay with the agreed payload', async () => {
    const { caller } = await initTest(2);
    await generateFederationKeys();
    mockDns();
    const { shadowId } = await seedShadowInDmWith(2);
    const { calls } = spyOnFetch(unavailable);
    const [reporter] = await db
      .select({ publicId: users.publicId })
      .from(users)
      .where(eq(users.id, 2));

    await caller.reports.create({
      kind: 'user',
      targetId: shadowId,
      reason: 'harassment',
      details: 'keeps pinging me'
    });
    await waitUntil(async () => (await db.select().from(federationOutbox)).length >= 1);

    // Local row still created.
    const [local] = await db
      .select()
      .from(reports)
      .where(eq(reports.targetUserId, shadowId));
    expect(local).toBeDefined();
    expect(local!.audience).toBe('instance');

    const rows = await db.select().from(federationOutbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('/federation/report-user');
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.payload).toEqual({
      subjectPublicId: 'report-shadow-home-pid',
      reporterPublicId: reporter!.publicId,
      serverPublicId: null,
      kind: 'user',
      reason: 'harassment',
      details: 'keeps pinging me',
      messageExcerpt: null
    });

    const relays = calls.filter((c) => c.url.includes('/federation/report-user'));
    expect(relays).toHaveLength(1);
    expect(relays[0]!.body.subjectPublicId).toBe('report-shadow-home-pid');
  });

  test('a DM-message report carries the message excerpt', async () => {
    const { caller } = await initTest(2);
    await generateFederationKeys();
    mockDns();
    const { shadowId, channelId } = await seedShadowInDmWith(2);
    spyOnFetch(unavailable);
    const [msg] = await db
      .insert(dmMessages)
      .values({
        dmChannelId: channelId,
        userId: shadowId,
        content: 'x'.repeat(1500),
        createdAt: Date.now()
      })
      .returning();

    await caller.reports.create({
      kind: 'dm_message',
      targetId: msg!.id,
      reason: 'spam'
    });
    await waitUntil(async () => (await db.select().from(federationOutbox)).length >= 1);

    const rows = await db.select().from(federationOutbox);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.kind).toBe('dm_message');
    expect(payload.reason).toBe('spam');
    expect(payload.details).toBeNull();
    // Bounded excerpt: the peer gets at most 1000 chars.
    expect((payload.messageExcerpt as string).length).toBe(1000);
  });

  test('a report on a local user queues nothing', async () => {
    const { caller } = await initTest(2);
    await generateFederationKeys();
    mockDns();
    await seedShadowInDmWith(2);
    const { calls } = spyOnFetch(unavailable);

    // users 2 and 3 share server 1.
    await caller.reports.create({
      kind: 'user',
      targetId: 3,
      reason: 'other'
    });
    await sleep(150);

    expect(await db.select().from(federationOutbox)).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes('/federation/report-user'))).toHaveLength(0);
  });
});
