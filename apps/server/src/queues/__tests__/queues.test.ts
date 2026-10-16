import { ActivityLogType, ServerEvents } from '@pulse/shared';
import { describe, expect, mock, spyOn, test } from 'bun:test';
import dns from 'dns/promises';
import { eq, isNull } from 'drizzle-orm';
import Queue from 'queue';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { activityLog, messages, servers, users } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { activityLogQueue, enqueueActivityLog } from '../activity-log';
import { drainQueue } from '../drain';
import { enqueueProcessMetadata, messageMetadataQueue } from '../message-metadata';
import {
  hasLinkPreviewCandidate,
  MAX_PREVIEW_URLS_PER_MESSAGE,
  metadataCache,
  PreviewCache,
  processMessageMetadata,
  urlMetadataParser
} from '../message-metadata/get-message-metadata';

/**
 * The fire-and-forget queues (queue@7). The library reacts to ONE
 * rejected job by `end(error)`, which empties the whole queue: every
 * audit row / login / preview already queued behind it was lost in
 * silence. Jobs now catch their own failures and always complete.
 */
describe('queues', () => {
  test('a failing activity-log job does not discard the jobs queued behind it', async () => {
    await initTest(1);

    // A user id that violates the FK: this job's insert rejects.
    enqueueActivityLog({
      type: ActivityLogType.USER_BANNED,
      userId: 987654,
      details: { reason: 'queue-test', bannedBy: 1 }
    });
    enqueueActivityLog({
      type: ActivityLogType.USER_BANNED,
      userId: 1,
      details: { reason: 'queue-test-good', bannedBy: 1 }
    });

    await drainQueue(activityLogQueue);

    const rows = await tdb
      .select()
      .from(activityLog)
      .where(eq(activityLog.type, ActivityLogType.USER_BANNED));

    expect(rows.map((r) => r.userId)).toEqual([1]);
    expect(activityLogQueue.length).toBe(0);

    // The queue is still usable after the failure.
    enqueueActivityLog({
      type: ActivityLogType.USER_UNBANNED,
      userId: 1,
      details: { unbannedBy: 1 }
    });
    await drainQueue(activityLogQueue);

    const after = await tdb
      .select()
      .from(activityLog)
      .where(eq(activityLog.type, ActivityLogType.USER_UNBANNED));
    expect(after).toHaveLength(1);
  });

  test('a system event on a database with no users is written with a null actor', async () => {
    // Fresh install: SERVER_STARTED is enqueued before any user exists.
    // The old hard-coded actor id 1 violated the FK here and took every
    // later queued row down with it.
    // The seeded owner is referenced by servers.owner_id; release it so
    // the users table can be emptied like a never-registered instance.
    await tdb.update(servers).set({ ownerId: null });
    await tdb.delete(users);
    expect(await tdb.select().from(users)).toHaveLength(0);

    enqueueActivityLog({ type: ActivityLogType.SERVER_STARTED });
    await drainQueue(activityLogQueue);

    const rows = await tdb
      .select()
      .from(activityLog)
      .where(eq(activityLog.type, ActivityLogType.SERVER_STARTED));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBeNull();
    expect(
      await tdb.select().from(activityLog).where(isNull(activityLog.userId))
    ).toHaveLength(1);
  });

  test('the library really does drop queued jobs on an unhandled rejection (why every job catches)', async () => {
    const queue = new Queue({ concurrency: 1, autostart: true });
    queue.addEventListener('error', () => {});
    let secondRan = false;

    queue.push(async () => {
      throw new Error('boom');
    });
    queue.push(async () => {
      secondRan = true;
    });

    await drainQueue(queue, 500);

    expect(secondRan).toBe(false);
    expect(queue.length).toBe(0);
  });

  test('a message without a URL publishes one NEW_MESSAGE and no MESSAGE_UPDATE', async () => {
    const { caller } = await initTest(1);
    const spy = spyOn(pubsub, 'publishFor');

    try {
      await caller.messages.send({
        channelId: 1,
        content: 'no links in here, just words',
        files: []
      });

      // publishMessage is fire-and-forget (several queries deep), so
      // wait for the NEW_MESSAGE fan-out, then give the metadata queue
      // and any MESSAGE_UPDATE it would publish time to land.
      const topics = () => spy.mock.calls.map(([, topic]) => topic);
      const deadline = Date.now() + 3000;
      while (
        !topics().includes(ServerEvents.NEW_MESSAGE) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(20);
      }
      await drainQueue(messageMetadataQueue);
      await Bun.sleep(200);

      expect(topics().filter((t) => t === ServerEvents.NEW_MESSAGE)).toHaveLength(1);
      expect(topics().filter((t) => t === ServerEvents.MESSAGE_UPDATE)).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test('enqueueProcessMetadata skips messages without http(s) URLs', () => {
    const before = messageMetadataQueue.length;

    enqueueProcessMetadata('plain text, ftp://not-a-web-link, www.example.com', 1);

    expect(messageMetadataQueue.length).toBe(before);
    expect(hasLinkPreviewCandidate('see HTTPS://Example.com')).toBe(true);
    expect(hasLinkPreviewCandidate('see example.com')).toBe(false);
  });

  test('processMessageMetadata returns null and leaves the row untouched when nothing previews', async () => {
    const { caller } = await initTest(1);
    const messageId = await caller.messages.send({
      channelId: 1,
      content: 'hello',
      files: []
    });
    const [before] = await tdb
      .select()
      .from(messages)
      .where(eq(messages.id, messageId));

    // Even with a URL, a fetcher that yields nothing means no UPDATE.
    const result = await processMessageMetadata(
      'https://example.com/nothing',
      messageId,
      async () => undefined
    );

    expect(result).toBeNull();

    const [after] = await tdb
      .select()
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(after!.updatedAt).toBe(before!.updatedAt);
    expect(after!.metadata).toEqual(before!.metadata);
  });

  test('link previews are capped at 5 URLs per message and survive individual failures', async () => {
    const resolve4 = spyOn(dns, 'resolve4').mockResolvedValue(['203.0.113.1']);
    const resolve6 = spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));

    try {
      metadataCache.clear();

      const urls = Array.from(
        { length: 50 },
        (_, i) => `https://example.com/page-${i}`
      );
      const fetched: string[] = [];
      const fetcher = async (url: string) => {
        fetched.push(url);
        if (url.endsWith('page-1')) throw new Error('fetch failed');
        return { url, title: `title ${url}` } as never;
      };

      const metadata = await urlMetadataParser(urls.join(' '), fetcher);

      expect(fetched.length).toBeLessThanOrEqual(MAX_PREVIEW_URLS_PER_MESSAGE);
      expect(fetched).toEqual(urls.slice(0, MAX_PREVIEW_URLS_PER_MESSAGE));
      // page-1 failed; the other four previews still land.
      expect(metadata).toHaveLength(MAX_PREVIEW_URLS_PER_MESSAGE - 1);

      // Second pass is served from the cache: no fetches at all.
      fetched.length = 0;
      await urlMetadataParser(urls.join(' '), fetcher);
      expect(fetched).toEqual([urls[1]!]);
    } finally {
      resolve4.mockRestore();
      resolve6.mockRestore();
      metadataCache.clear();
    }
  });

  test('a URL failing validation is skipped without touching the fetcher', async () => {
    const resolve4 = spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.5']);
    const resolve6 = spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));

    try {
      let calls = 0;
      const metadata = await urlMetadataParser(
        'https://internal.example/secret',
        async () => {
          calls += 1;
          return undefined;
        }
      );

      expect(calls).toBe(0);
      expect(metadata).toEqual([]);
    } finally {
      resolve4.mockRestore();
      resolve6.mockRestore();
    }
  });

  test('the preview cache is bounded (LRU) and honours its TTL', () => {
    const cache = new PreviewCache(3, 60_000);
    const entry = (url: string) => ({ url }) as never;

    cache.set('a', entry('a'));
    cache.set('b', entry('b'));
    cache.set('c', entry('c'));
    // Touch 'a' so 'b' becomes the least recently used.
    expect(cache.get('a')).toBeDefined();
    cache.set('d', entry('d'));

    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();

    const expiring = new PreviewCache(10, -1);
    expiring.set('x', entry('x'));
    expect(expiring.get('x')).toBeUndefined();
    expect(expiring.size).toBe(0);
  });
});
