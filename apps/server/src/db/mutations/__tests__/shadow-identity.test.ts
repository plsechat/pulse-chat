import { afterEach, describe, expect, mock, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  mockDns,
  PEER_DOMAIN,
  seedPeer,
  seedPeerInstance,
  spyOnFetch,
  TEST_LOCAL_DOMAIN
} from '../../../__tests__/federation-fixtures';
import { getTestDb } from '../../../__tests__/mock-db';
import { _signChallengeAs } from '../../../utils/federation';
import { users } from '../../schema';
import {
  findOrCreateShadowUser,
  findOrCreateShadowUserByPublicId,
  verifyRemoteUserAttestation
} from '../federation';

afterEach(() => {
  mock.restore();
});

const shadowsOf = async (instanceId: number) =>
  getTestDb()
    .select({
      id: users.id,
      name: users.name,
      federatedPublicId: users.federatedPublicId,
      federatedUsername: users.federatedUsername,
      supabaseId: users.supabaseId
    })
    .from(users)
    .where(
      and(eq(users.isFederated, true), eq(users.federatedInstanceId, instanceId))
    )
    .orderBy(users.id);

/**
 * A shadow is identified by (home instance, publicId) and nothing else.
 * The peer's numeric id used to be a lookup key, which let one remote
 * user be handed another's shadow.
 */
describe('shadow identity is (instance, publicId) only', () => {
  test('same numeric id with a different publicId is a different shadow', async () => {
    const instanceId = await seedPeerInstance(PEER_DOMAIN);

    // A client-minted shadow for P never carried a numeric id.
    const p = await findOrCreateShadowUserByPublicId(instanceId, 'pid-P', 'Pat');
    // The real remote user #5 (Q) connects over the token path.
    const q = await findOrCreateShadowUser(instanceId, 5, 'Quinn', undefined, 'pid-Q');

    expect(q.id).not.toBe(p.id);
    const rows = await shadowsOf(instanceId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.federatedPublicId).sort()).toEqual(['pid-P', 'pid-Q']);
  });

  test('a stored numeric id is never a lookup key', async () => {
    const instanceId = await seedPeerInstance(PEER_DOMAIN);

    // P's shadow happens to carry federatedUsername '5' (informational).
    const p = await findOrCreateShadowUser(instanceId, 5, 'Pat', undefined, 'pid-P');
    expect(p.federatedUsername).toBe('5');

    // The real user #5 (publicId Q) must not land on P's row.
    const q = await findOrCreateShadowUser(instanceId, 5, 'Quinn', undefined, 'pid-Q');
    expect(q.id).not.toBe(p.id);
    expect(q.name).toBe('Quinn');

    const [pRow] = await getTestDb()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, p.id));
    expect(pRow!.name).toBe('Pat');
  });

  test('repeat lookups by publicId return the same row and refresh the name', async () => {
    const instanceId = await seedPeerInstance(PEER_DOMAIN);

    const first = await findOrCreateShadowUser(instanceId, 0, 'Old Name', undefined, 'pid-P');
    const again = await findOrCreateShadowUser(instanceId, 7, 'New Name', undefined, 'pid-P');

    expect(again.id).toBe(first.id);
    expect(again.name).toBe('New Name');
    expect(again.federatedUsername).toBe('7');
    expect((await shadowsOf(instanceId))).toHaveLength(1);
  });

  test('the same publicId minted concurrently yields one row', async () => {
    const instanceId = await seedPeerInstance(PEER_DOMAIN);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        findOrCreateShadowUser(instanceId, 9, `Racer ${i}`, undefined, 'pid-race')
      )
    );

    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(await shadowsOf(instanceId)).toHaveLength(1);
  });

  test('new rows get an opaque supabaseId, not one derived from the numeric id', async () => {
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    const p = await findOrCreateShadowUser(instanceId, 5, 'Pat', undefined, 'pid-P');
    expect(p.supabaseId).toMatch(/^federated-/);
    expect(p.supabaseId).not.toContain(':5');
  });

  test('a missing publicId is refused instead of minting an unidentifiable row', async () => {
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    await expect(
      findOrCreateShadowUser(instanceId, 5, 'Nobody', undefined, undefined)
    ).rejects.toThrow('publicId');
    expect(await shadowsOf(instanceId)).toHaveLength(0);
  });
});

/**
 * Third-instance members of a relayed group DM are only minted when their
 * own home instance vouches for them with a signed user-info reply.
 */
describe('verifyRemoteUserAttestation', () => {
  const signedUserInfo = async (
    body: Record<string, unknown>,
    privateJwk: Parameters<typeof _signChallengeAs>[3]
  ): Promise<Response> => {
    const bodyToSign = { ...body, fromDomain: PEER_DOMAIN };
    const signature = await _signChallengeAs(
      bodyToSign,
      PEER_DOMAIN,
      TEST_LOCAL_DOMAIN,
      privateJwk
    );
    return new Response(JSON.stringify({ ...bodyToSign, signature }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  test('returns the home instance\'s name when its signed reply verifies', async () => {
    const { peerPrivateJwk } = await seedPeer();
    mockDns();
    const { calls } = spyOnFetch((call) =>
      call.url.endsWith('/federation/user-info')
        ? signedUserInfo({ name: 'Carol', bio: null }, peerPrivateJwk)
        : new Response('not found', { status: 404 })
    );

    const result = await verifyRemoteUserAttestation(PEER_DOMAIN, 'pid-carol');

    expect(result).toEqual({ name: 'Carol' });
    const query = calls.find((c) => c.url.endsWith('/federation/user-info'));
    expect(query?.body.publicId).toBe('pid-carol');
    expect(typeof query?.body.signature).toBe('string');
  });

  test('bounds the attested name like any shadow name', async () => {
    const { peerPrivateJwk } = await seedPeer();
    mockDns();
    spyOnFetch(() => signedUserInfo({ name: 'x'.repeat(200) }, peerPrivateJwk));

    const result = await verifyRemoteUserAttestation(PEER_DOMAIN, 'pid-long');
    expect(result?.name).toHaveLength(32);
  });

  test('an unsigned reply is not an attestation', async () => {
    await seedPeer();
    mockDns();
    spyOnFetch(
      () =>
        new Response(JSON.stringify({ name: 'Mallory' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    );

    expect(await verifyRemoteUserAttestation(PEER_DOMAIN, 'pid-m')).toBeNull();
  });

  test('a reply signed with the wrong key is rejected', async () => {
    await seedPeer();
    // A second keypair the local instance has never pinned for the peer.
    const { peerPrivateJwk: strangerJwk } = await seedPeer('stranger.example');
    mockDns();
    spyOnFetch(() => signedUserInfo({ name: 'Mallory' }, strangerJwk));

    expect(await verifyRemoteUserAttestation(PEER_DOMAIN, 'pid-m')).toBeNull();
  });

  test('unknown user (404), nameless reply and unknown instance all yield null', async () => {
    const { peerPrivateJwk } = await seedPeer();
    mockDns();

    spyOnFetch(() => new Response('{"error":"User not found"}', { status: 404 }));
    expect(await verifyRemoteUserAttestation(PEER_DOMAIN, 'pid-x')).toBeNull();
    mock.restore();

    mockDns();
    spyOnFetch(() => signedUserInfo({ bio: 'no name here' }, peerPrivateJwk));
    expect(await verifyRemoteUserAttestation(PEER_DOMAIN, 'pid-x')).toBeNull();
    mock.restore();

    mockDns();
    const { calls } = spyOnFetch(() => signedUserInfo({ name: 'Carol' }, peerPrivateJwk));
    expect(await verifyRemoteUserAttestation('nobody.example', 'pid-x')).toBeNull();
    // Not a peer of ours: nothing was even asked.
    expect(calls).toHaveLength(0);
  });
});
