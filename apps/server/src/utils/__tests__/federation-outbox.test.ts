/**
 * Durable federation outbox — scheduling, dead-lettering and the
 * per-peer drain. The network attempt is stubbed through
 * `_setOutboxRelayForTests` so the schedule can be driven
 * deterministically; one test keeps the real attempt (fetch spy + DNS
 * mock) to prove the wiring through `relayToInstanceDetailed`.
 *
 * Setup is inline per test (no beforeEach — it deadlocks against the
 * global TRUNCATE).
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { federationInstances, federationOutbox } from '../../db/schema';
import {
  mockDns,
  seedPeerInstance,
  spyOnFetch
} from '../../__tests__/federation-fixtures';
import { generateFederationKeys } from '../federation';
import {
  _setOutboxRelayForTests,
  drainFederationOutbox,
  enqueueRelay,
  retryDeadOutboxRows
} from '../federation-outbox';

const PEER_A = 'peer-a.outbox.example.com';
const PEER_B = 'peer-b.outbox.example.com';

afterEach(() => {
  _setOutboxRelayForTests(undefined);
  mock.restore();
});

type Call = { domain: string; path: string; payload: Record<string, unknown> };

/** Stub whose outcomes are consumed in order; the last one repeats. */
const stubRelay = (
  outcomes: Array<{
    ok: boolean;
    status?: number;
    error?: string;
    rateLimited?: boolean;
    retryAfterMs?: number;
  }>
) => {
  const calls: Call[] = [];
  let i = 0;
  _setOutboxRelayForTests(async (domain, path, payload) => {
    calls.push({ domain, path, payload });
    const outcome = outcomes[Math.min(i, outcomes.length - 1)]!;
    i += 1;
    return outcome;
  });
  return calls;
};

const rowsFor = (path: string) =>
  db.select().from(federationOutbox).where(eq(federationOutbox.path, path));

/** Make every live row due now so the next drain picks it up. */
const makeAllDue = () =>
  db.update(federationOutbox).set({ nextAttemptAt: Date.now() - 1 });

describe('enqueueRelay', () => {
  test('fails twice then succeeds: attempts reach 2, then the row is deleted', async () => {
    await seedPeerInstance(PEER_A);
    const calls = stubRelay([
      { ok: false, error: 'TimeoutError: timed out' },
      { ok: false, error: 'TimeoutError: timed out' },
      { ok: true, status: 200 }
    ]);

    const delivered = await enqueueRelay(PEER_A, '/federation/x', { n: 1 });
    expect(delivered).toBe(false);

    let [row] = await rowsFor('/federation/x');
    expect(row!.attempts).toBe(1);
    expect(row!.deadAt).toBeNull();
    expect(row!.lastError).toBe('TimeoutError: timed out');
    // First backoff step: ~30 s out.
    expect(row!.nextAttemptAt - Date.now()).toBeGreaterThan(25_000);

    await makeAllDue();
    await drainFederationOutbox();
    [row] = await rowsFor('/federation/x');
    expect(row!.attempts).toBe(2);
    // Second step: ~2 min out.
    expect(row!.nextAttemptAt - Date.now()).toBeGreaterThan(100_000);

    await makeAllDue();
    expect(await drainFederationOutbox()).toBe(1);
    expect(await rowsFor('/federation/x')).toHaveLength(0);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.payload).toEqual({ n: 1 });
  });

  test('dead-letters after the maximum number of attempts', async () => {
    await seedPeerInstance(PEER_A);
    stubRelay([{ ok: false, status: 500, error: 'http:500' }]);

    await enqueueRelay(PEER_A, '/federation/max', {});
    for (let i = 0; i < 6; i++) {
      await makeAllDue();
      await drainFederationOutbox();
    }
    let [row] = await rowsFor('/federation/max');
    expect(row!.attempts).toBe(7);
    expect(row!.deadAt).toBeNull();

    await makeAllDue();
    await drainFederationOutbox();
    [row] = await rowsFor('/federation/max');
    expect(row!.attempts).toBe(8);
    expect(row!.deadAt).not.toBeNull();
    expect(row!.lastError).toBe('http:500');

    // Dead rows are never picked up again.
    await makeAllDue();
    expect(await drainFederationOutbox()).toBe(0);
    [row] = await rowsFor('/federation/max');
    expect(row!.attempts).toBe(8);
  });

  test('a 404 dead-letters immediately with unsupported:<path>', async () => {
    await seedPeerInstance(PEER_A);
    const calls = stubRelay([{ ok: false, status: 404, error: 'unsupported:/federation/new-route' }]);

    await enqueueRelay(PEER_A, '/federation/new-route', { a: 1 });

    const [row] = await rowsFor('/federation/new-route');
    expect(row!.attempts).toBe(1);
    expect(row!.deadAt).not.toBeNull();
    expect(row!.lastError).toBe('unsupported:/federation/new-route');

    await makeAllDue();
    await drainFederationOutbox();
    expect(calls).toHaveLength(1);
  });

  test('an outbound rate limit defers 60 s without counting an attempt', async () => {
    await seedPeerInstance(PEER_A);
    stubRelay([
      {
        ok: false,
        rateLimited: true,
        error: 'FederationRateLimitError: Outbound federation rate limit exceeded'
      }
    ]);

    await enqueueRelay(PEER_A, '/federation/limited', {});

    const [row] = await rowsFor('/federation/limited');
    expect(row!.attempts).toBe(0);
    expect(row!.deadAt).toBeNull();
    const delay = row!.nextAttemptAt - Date.now();
    expect(delay).toBeGreaterThan(55_000);
    expect(delay).toBeLessThan(65_000);
  });

  test('a 429 from the peer defers by its Retry-After without counting an attempt', async () => {
    await seedPeerInstance(PEER_A);
    stubRelay([
      { ok: false, status: 429, rateLimited: true, retryAfterMs: 120_000, error: 'http:429' }
    ]);

    await enqueueRelay(PEER_A, '/federation/limited', {});

    const [row] = await rowsFor('/federation/limited');
    expect(row!.attempts).toBe(0);
    expect(row!.deadAt).toBeNull();
    const delay = row!.nextAttemptAt - Date.now();
    expect(delay).toBeGreaterThan(115_000);
    expect(delay).toBeLessThan(125_000);
  });

  test('transient relays are attempted once and never persisted', async () => {
    await seedPeerInstance(PEER_A);
    const calls = stubRelay([{ ok: false, error: 'TimeoutError: timed out' }]);

    const ok = await enqueueRelay(
      PEER_A,
      '/federation/user-info-update',
      { status: 'online' },
      { transient: true }
    );

    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await rowsFor('/federation/user-info-update')).toHaveLength(0);
  });

  test('a peer that is not active gets no row and no attempt', async () => {
    const calls = stubRelay([{ ok: true }]);

    const ok = await enqueueRelay('unknown.outbox.example.com', '/federation/x', {});

    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await rowsFor('/federation/x')).toHaveLength(0);
  });

  test('opts.relayId is added to the payload', async () => {
    await seedPeerInstance(PEER_A);
    const calls = stubRelay([{ ok: true }]);

    await enqueueRelay(PEER_A, '/federation/dm-relay', { content: 'hi' }, { relayId: 'r-1' });

    expect(calls[0]!.payload).toEqual({ content: 'hi', relayId: 'r-1' });
  });

  test('the real attempt signs and POSTs through fetch and deletes the row on 200', async () => {
    await generateFederationKeys();
    mockDns();
    await seedPeerInstance(PEER_A);
    const { calls } = spyOnFetch();

    const ok = await enqueueRelay(PEER_A, '/federation/friend-remove', { toPublicId: 'p' });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    // The dial goes to the pinned address; the peer name rides in Host.
    expect(calls[0]!.url).toContain('/federation/friend-remove');
    expect(calls[0]!.body.toPublicId).toBe('p');
    expect(calls[0]!.body.fromDomain).toBe('test.local');
    expect(typeof calls[0]!.body.signature).toBe('string');
    expect(await rowsFor('/federation/friend-remove')).toHaveLength(0);
  });
});

describe('drainFederationOutbox', () => {
  test('drains each peer in due order and stops a peer after a connection failure', async () => {
    await seedPeerInstance(PEER_A);
    await seedPeerInstance(PEER_B);
    // Everything fails inline so three rows are queued.
    const calls = stubRelay([{ ok: false, error: 'TimeoutError: timed out' }]);
    await enqueueRelay(PEER_A, '/federation/a1', {});
    await enqueueRelay(PEER_A, '/federation/a2', {});
    await enqueueRelay(PEER_B, '/federation/b1', {});
    calls.length = 0;

    // a2 due before a1: the drain must follow next_attempt_at, not id.
    const now = Date.now();
    const [a1] = await rowsFor('/federation/a1');
    const [a2] = await rowsFor('/federation/a2');
    const [b1] = await rowsFor('/federation/b1');
    await db.update(federationOutbox).set({ nextAttemptAt: now - 100 }).where(eq(federationOutbox.id, a2!.id));
    await db.update(federationOutbox).set({ nextAttemptAt: now - 50 }).where(eq(federationOutbox.id, a1!.id));
    await db.update(federationOutbox).set({ nextAttemptAt: now - 10 }).where(eq(federationOutbox.id, b1!.id));

    // Peer A succeeds on everything, peer B is unreachable.
    _setOutboxRelayForTests(async (domain, path, payload) => {
      calls.push({ domain, path, payload });
      return domain === PEER_A ? { ok: true } : { ok: false, error: 'ConnectionRefused' };
    });

    expect(await drainFederationOutbox()).toBe(2);
    const aOrder = calls.filter((c) => c.domain === PEER_A).map((c) => c.path);
    expect(aOrder).toEqual(['/federation/a2', '/federation/a1']);
    expect(calls.filter((c) => c.domain === PEER_B)).toHaveLength(1);
    expect(await rowsFor('/federation/a1')).toHaveLength(0);
    expect(await rowsFor('/federation/a2')).toHaveLength(0);
    expect((await rowsFor('/federation/b1'))[0]!.attempts).toBe(2);
  });

  test('a peer that is up but rejects one row still gets its next row', async () => {
    await seedPeerInstance(PEER_A);
    const calls = stubRelay([{ ok: false, error: 'TimeoutError: timed out' }]);
    await enqueueRelay(PEER_A, '/federation/first', {});
    await enqueueRelay(PEER_A, '/federation/second', {});
    calls.length = 0;
    await makeAllDue();

    _setOutboxRelayForTests(async (domain, path, payload) => {
      calls.push({ domain, path, payload });
      return path === '/federation/first'
        ? { ok: false, status: 500, error: 'http:500' }
        : { ok: true };
    });

    expect(await drainFederationOutbox()).toBe(1);
    expect(calls.map((c) => c.path)).toEqual(['/federation/first', '/federation/second']);
  });

  test('rows of a blocked peer are left alone', async () => {
    const instanceId = await seedPeerInstance(PEER_A);
    const calls = stubRelay([{ ok: false, error: 'TimeoutError: timed out' }]);
    await enqueueRelay(PEER_A, '/federation/x', {});
    calls.length = 0;
    await makeAllDue();
    await db.update(federationInstances).set({ status: 'blocked' }).where(eq(federationInstances.id, instanceId));

    expect(await drainFederationOutbox()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('retryDeadOutboxRows', () => {
  test('revives a peer\'s dead rows so the next drain delivers them', async () => {
    const instanceId = await seedPeerInstance(PEER_A);
    stubRelay([{ ok: false, status: 404, error: 'unsupported:/federation/x' }]);
    await enqueueRelay(PEER_A, '/federation/x', { v: 1 });
    expect((await rowsFor('/federation/x'))[0]!.deadAt).not.toBeNull();

    expect(await retryDeadOutboxRows(instanceId)).toBe(1);
    const [row] = await rowsFor('/federation/x');
    expect(row!.deadAt).toBeNull();
    expect(row!.attempts).toBe(0);
    expect(row!.lastError).toBeNull();

    stubRelay([{ ok: true }]);
    expect(await drainFederationOutbox()).toBe(1);
    expect(await rowsFor('/federation/x')).toHaveLength(0);
  });
});
