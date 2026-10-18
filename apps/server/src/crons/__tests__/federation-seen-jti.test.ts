/**
 * federation-seen-jti cron — expired replay-cache rows and retired
 * signing keys past their grace go; live jtis, freshly retired keys and
 * the live key stay.
 *
 * Setup is inline per test (no beforeEach) — see cleanup-auth-sessions.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { getTestDb } from '../../__tests__/mock-db';
import { federationKeys, federationSeenJti } from '../../db/schema';
import { FEDERATION_KEY_GRACE_MS } from '../../utils/federation';
import { pruneFederationReplayState } from '../federation-seen-jti';

const HOUR_MS = 60 * 60 * 1000;

const insertKey = async (retiredAt: number | null) => {
  const [row] = await getTestDb()
    .insert(federationKeys)
    .values({
      publicKey: '{"kty":"OKP"}',
      privateKey: '{"kty":"OKP"}',
      createdAt: Date.now() - 48 * HOUR_MS,
      retiredAt
    })
    .returning({ id: federationKeys.id });
  return row!.id;
};

describe('federation-seen-jti cron', () => {
  test('removes expired jtis and keys retired past the grace window', async () => {
    const now = Date.now();
    const expiredJti = randomUUIDv7();
    const liveJti = randomUUIDv7();
    await getTestDb().insert(federationSeenJti).values([
      { jti: expiredJti, expiresAt: now - 60_000 },
      { jti: liveJti, expiresAt: now + 5 * 60_000 }
    ]);
    const stale = await insertKey(now - FEDERATION_KEY_GRACE_MS - HOUR_MS);
    const recent = await insertKey(now - HOUR_MS);
    const live = await insertKey(null);

    const removed = await pruneFederationReplayState();

    expect(removed).toEqual({ jtis: 1, keys: 1 });
    const jtis = (await getTestDb().select().from(federationSeenJti)).map((r) => r.jti);
    expect(jtis).toEqual([liveJti]);
    const keys = (await getTestDb().select().from(federationKeys)).map((r) => r.id).sort();
    expect(keys).toEqual([recent, live].sort());
    expect(keys).not.toContain(stale);
  });

  test('a jti backlog larger than one batch is drained completely', async () => {
    const now = Date.now();
    await getTestDb().insert(federationSeenJti).values(
      Array.from({ length: 2500 }, () => ({
        jti: randomUUIDv7(),
        expiresAt: now - 1000
      }))
    );

    const removed = await pruneFederationReplayState();

    expect(removed.jtis).toBe(2500);
    expect(await getTestDb().select().from(federationSeenJti)).toHaveLength(0);
  });
});
