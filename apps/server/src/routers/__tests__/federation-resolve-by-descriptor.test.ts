import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { seedPeerInstance, PEER_DOMAIN } from '../../__tests__/federation-fixtures';
import { insertMemberUser } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { friendships, userFederatedServers, users } from '../../db/schema';
import { _resetResolveByDescriptorRateLimit } from '../users/resolve-by-descriptor';

/**
 * `users.resolveByDescriptor` mints shadow users on demand. Any
 * authenticated user can call it, so the inputs are bounded and a
 * shadow is only minted for callers who take part in federation.
 */
describe('users.resolveByDescriptor', () => {
  const joinFederatedServer = async (userId: number, instanceId: number) => {
    await getTestDb().insert(userFederatedServers).values({
      userId,
      instanceId,
      remoteServerId: 1,
      remoteServerPublicId: 'remote-srv',
      remoteServerName: 'Remote',
      joinedAt: Date.now()
    });
  };

  const findShadow = async (instanceId: number, publicId: string) => {
    const [row] = await getTestDb()
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(
        and(
          eq(users.federatedInstanceId, instanceId),
          eq(users.federatedPublicId, publicId)
        )
      )
      .limit(1);
    return row;
  };

  test('bounds: oversize name, publicId and malformed domain are rejected', async () => {
    _resetResolveByDescriptorRateLimit();
    const { caller } = await initTest(1);

    await expect(
      caller.users.resolveByDescriptor({
        publicId: 'pid',
        instanceDomain: PEER_DOMAIN,
        name: 'x'.repeat(10_240)
      })
    ).rejects.toThrow();
    await expect(
      caller.users.resolveByDescriptor({
        publicId: 'p'.repeat(65),
        instanceDomain: PEER_DOMAIN
      })
    ).rejects.toThrow();
    await expect(
      caller.users.resolveByDescriptor({
        publicId: 'pid',
        instanceDomain: 'evil.example/path'
      })
    ).rejects.toThrow();
  });

  test('unknown or inactive instance resolves to null without minting', async () => {
    _resetResolveByDescriptorRateLimit();
    const { caller } = await initTest(1);

    expect(
      await caller.users.resolveByDescriptor({
        publicId: 'pid',
        instanceDomain: 'nobody.example'
      })
    ).toEqual({ id: null });
  });

  test('a caller with no federation relationship cannot mint a shadow', async () => {
    _resetResolveByDescriptorRateLimit();
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    const member = await insertMemberUser();
    const { caller } = await initTest(member.id);

    await expect(
      caller.users.resolveByDescriptor({
        publicId: 'remote-pid',
        instanceDomain: PEER_DOMAIN,
        name: 'Remote'
      })
    ).rejects.toThrow('No federation relationship');

    expect(await findShadow(instanceId, 'remote-pid')).toBeUndefined();
  });

  test('a member of a federated server mints the shadow', async () => {
    _resetResolveByDescriptorRateLimit();
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    const member = await insertMemberUser();
    await joinFederatedServer(member.id, instanceId);
    const { caller } = await initTest(member.id);

    const result = await caller.users.resolveByDescriptor({
      publicId: 'remote-pid',
      instanceDomain: PEER_DOMAIN,
      name: 'Remote Person'
    });
    expect(result.id).not.toBeNull();

    const shadow = await findShadow(instanceId, 'remote-pid');
    expect(shadow?.id).toBe(result.id!);
    expect(shadow?.name).toBe('Remote Person');
  });

  test('a friend of a user from that instance may mint another shadow of it', async () => {
    _resetResolveByDescriptorRateLimit();
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    const member = await insertMemberUser();
    const tdb = getTestDb();
    const [friendShadow] = await tdb
      .insert(users)
      .values({
        supabaseId: 'federated-friend',
        name: 'Friend',
        publicId: 'friend-local-pid',
        isFederated: true,
        federatedInstanceId: instanceId,
        federatedPublicId: 'friend-remote-pid',
        createdAt: Date.now()
      })
      .returning();
    await tdb.insert(friendships).values({
      userId: friendShadow!.id,
      friendId: member.id,
      createdAt: Date.now()
    });
    const { caller } = await initTest(member.id);

    const result = await caller.users.resolveByDescriptor({
      publicId: 'other-remote-pid',
      instanceDomain: PEER_DOMAIN,
      name: 'Other'
    });
    expect(result.id).not.toBeNull();
  });

  test('an existing shadow resolves for anyone and an omitted name never blanks it', async () => {
    _resetResolveByDescriptorRateLimit();
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    const [shadow] = await getTestDb()
      .insert(users)
      .values({
        supabaseId: 'federated-existing',
        name: 'Existing',
        publicId: 'existing-local-pid',
        isFederated: true,
        federatedInstanceId: instanceId,
        federatedPublicId: 'existing-remote-pid',
        createdAt: Date.now()
      })
      .returning();
    const member = await insertMemberUser();
    const { caller } = await initTest(member.id);

    const result = await caller.users.resolveByDescriptor({
      publicId: 'existing-remote-pid',
      instanceDomain: PEER_DOMAIN
    });
    expect(result.id).toBe(shadow!.id);
    expect((await findShadow(instanceId, 'existing-remote-pid'))?.name).toBe(
      'Existing'
    );
  });
});
