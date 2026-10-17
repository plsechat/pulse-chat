import { ChannelType } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { eq } from 'drizzle-orm';
import { createTestChannel, createTestServer } from '../../__tests__/fixtures';
import { getTestDb } from '../../__tests__/mock-db';
import { channels, importJobs, messages } from '../../db/schema';
import { cleanupEmptyThreads } from '../cleanup-empty-threads';

/**
 * The empty-thread sweep, driven by its tick with an injected `now`:
 * zero-message threads older than ten minutes go, EXCEPT in a server
 * whose community import is still in flight — its threads step creates
 * every thread first and fills them later, and sweeping them failed the
 * whole import on the first thread message.
 */

const MINUTE_MS = 60_000;

const tdb = () => getTestDb();

/** A THREAD row created `ageMs` before `now`, with no messages. */
const insertThread = async (serverId: number, parentId: number, now: number, ageMs: number) => {
  const [row] = await tdb()
    .insert(channels)
    .values({
      type: ChannelType.THREAD,
      name: 'imported thread',
      position: 0,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: now,
      serverId,
      parentChannelId: parentId,
      publicId: randomUUIDv7(),
      createdAt: now - ageMs
    })
    .returning({ id: channels.id });
  return row!.id;
};

const insertJob = async (serverId: number, status: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled') => {
  const now = Date.now();
  const [row] = await tdb()
    .insert(importJobs)
    .values({
      serverId,
      createdBy: 1,
      source: 'discord',
      status,
      step: null,
      progress: {},
      options: {},
      tokenCiphertext: null,
      createdAt: now,
      updatedAt: now
    })
    .returning({ id: importJobs.id });
  return row!.id;
};

const exists = async (channelId: number) =>
  (await tdb().select({ id: channels.id }).from(channels).where(eq(channels.id, channelId))).length === 1;

describe('cleanupEmptyThreads', () => {
  test('a tick during an active import leaves that server\'s empty threads; after the job ends they go', async () => {
    const now = Date.now();
    const parent = await createTestChannel({ serverId: 1, name: 'general' });
    const importing = await insertThread(1, parent, now, 30 * MINUTE_MS);
    const jobId = await insertJob(1, 'running');

    // A second server with no import: its stale empty thread is swept.
    const otherServer = await createTestServer({ ownerId: 1, name: 'Other' });
    const otherParent = await createTestChannel({ serverId: otherServer, name: 'general' });
    const stray = await insertThread(otherServer, otherParent, now, 30 * MINUTE_MS);
    const young = await insertThread(otherServer, otherParent, now, 2 * MINUTE_MS);

    await cleanupEmptyThreads(now);
    expect(await exists(importing)).toBe(true);
    expect(await exists(stray)).toBe(false);
    expect(await exists(young)).toBe(true);

    // Paused still counts as in flight.
    await tdb().update(importJobs).set({ status: 'paused' }).where(eq(importJobs.id, jobId));
    await cleanupEmptyThreads(now);
    expect(await exists(importing)).toBe(true);

    // Once the job is over the thread is an ordinary stray.
    await tdb().update(importJobs).set({ status: 'done' }).where(eq(importJobs.id, jobId));
    await cleanupEmptyThreads(now);
    expect(await exists(importing)).toBe(false);

    // Time moves on: the young one ages into the window.
    await cleanupEmptyThreads(now + 20 * MINUTE_MS);
    expect(await exists(young)).toBe(false);
  });

  test('a thread with a message is never swept, import or not', async () => {
    const now = Date.now();
    const parent = await createTestChannel({ serverId: 1, name: 'general' });
    const thread = await insertThread(1, parent, now, 30 * MINUTE_MS);
    await tdb().insert(messages).values({
      content: 'in thread',
      userId: 1,
      channelId: thread,
      createdAt: now - 29 * MINUTE_MS
    });

    await cleanupEmptyThreads(now);
    expect(await exists(thread)).toBe(true);
  });
});
