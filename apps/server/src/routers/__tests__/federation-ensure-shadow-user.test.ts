import { afterEach, describe, expect, mock, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  mockDns,
  PEER_DOMAIN,
  seedPeer,
  spyOnFetch
} from '../../__tests__/federation-fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { findOrCreateShadowUser } from '../../db/mutations/federation';
import { users } from '../../db/schema';

afterEach(() => {
  mock.restore();
});

/** Answer `/federation/user-info` the way a peer does for a known user. */
const respondUserInfo = (name: string) =>
  spyOnFetch((call) =>
    call.url.endsWith('/federation/user-info')
      ? new Response(JSON.stringify({ name, bio: null, bannerColor: null, avatar: null, banner: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      : new Response('not found', { status: 404 })
  );

const shadowsOf = async (instanceId: number) =>
  getTestDb()
    .select({
      id: users.id,
      name: users.name,
      federatedPublicId: users.federatedPublicId,
      federatedUsername: users.federatedUsername
    })
    .from(users)
    .where(
      and(eq(users.isFederated, true), eq(users.federatedInstanceId, instanceId))
    )
    .orderBy(users.id);

// The route fires a profile sync it does not await; let it settle before
// the next test's TRUNCATE so no straggler races it.
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('federation.ensureShadowUser identity', () => {
  test('mints by publicId with the remote name; the token path for another publicId gets its own row', async () => {
    const { caller } = await initTest(1);
    const { peerInstanceId } = await seedPeer();
    mockDns();
    respondUserInfo('Pat (remote)');

    const first = await caller.federation.ensureShadowUser({
      instanceDomain: PEER_DOMAIN,
      username: 'client-controlled',
      remotePublicId: 'pid-P'
    });
    await settle();

    let rows = await shadowsOf(peerInstanceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.localUserId);
    expect(rows[0]!.name).toBe('Pat (remote)');
    expect(rows[0]!.federatedPublicId).toBe('pid-P');
    // No client-supplied numeric id is stored any more.
    expect(rows[0]!.federatedUsername).toBeNull();

    // The real remote user #5 (publicId Q) authenticates over a token —
    // the same call wss.ts / resolve-auth make after verifyFederationToken.
    const q = await findOrCreateShadowUser(peerInstanceId, 5, 'Quinn', undefined, 'pid-Q');
    expect(q.id).not.toBe(first.localUserId);

    rows = await shadowsOf(peerInstanceId);
    expect(rows).toHaveLength(2);

    // Asking for P again lands on P's original row.
    const again = await caller.federation.ensureShadowUser({
      instanceDomain: PEER_DOMAIN,
      username: 'client-controlled',
      remotePublicId: 'pid-P'
    });
    await settle();
    expect(again.localUserId).toBe(first.localUserId);
    expect(await shadowsOf(peerInstanceId)).toHaveLength(2);
  });

  test('a numeric id in the input is ignored, never stored as identity', async () => {
    const { caller } = await initTest(1);
    const { peerInstanceId } = await seedPeer();
    mockDns();
    respondUserInfo('Pat (remote)');

    // Older clients still send it; the schema strips unknown keys.
    await caller.federation.ensureShadowUser({
      instanceDomain: PEER_DOMAIN,
      username: 'x',
      remotePublicId: 'pid-P',
      remoteUserId: 5
    } as never);
    await settle();

    const [row] = await shadowsOf(peerInstanceId);
    expect(row!.federatedUsername).toBeNull();

    // So the real #5 is still a distinct identity.
    const q = await findOrCreateShadowUser(peerInstanceId, 5, 'Quinn', undefined, 'pid-Q');
    expect(q.id).not.toBe(row!.id);
  });

  test('a shadow only exists once the remote vouched for the publicId', async () => {
    const { caller } = await initTest(1);
    const { peerInstanceId } = await seedPeer();
    mockDns();
    spyOnFetch(() => new Response('{"error":"User not found"}', { status: 404 }));

    await expect(
      caller.federation.ensureShadowUser({
        instanceDomain: PEER_DOMAIN,
        username: 'ghost',
        remotePublicId: 'pid-ghost'
      })
    ).rejects.toThrow('Remote user not found');
    expect(await shadowsOf(peerInstanceId)).toHaveLength(0);
  });
});
