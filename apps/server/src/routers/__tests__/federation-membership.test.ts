import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { federationInstances } from '../../db/schema';
import { initTest } from '../../__tests__/helpers';

/**
 * Helper to create an active federation instance for testing.
 * Returns the inserted instance row.
 */
async function createTestInstance(domain = 'remote.example.com', name = 'Remote Instance') {
  const [instance] = await db
    .insert(federationInstances)
    .values({
      domain,
      name,
      status: 'active',
      direction: 'outgoing',
      createdAt: Date.now()
    })
    .returning();
  return instance!;
}

describe('federation membership', () => {
  test('confirmJoin creates a membership record', async () => {
    const { caller } = await initTest();
    const instance = await createTestInstance();

    await caller.federation.confirmJoin({
      instanceDomain: instance.domain,
      remoteServerId: 42,
      remoteServerPublicId: 'pub-42',
      remoteServerName: 'Remote Server'
    });

    const joined = await caller.federation.getJoined();
    expect(joined).toHaveLength(1);
    expect(joined[0]!.instanceDomain).toBe('remote.example.com');
    expect(joined[0]!.remoteServerId).toBe(42);
    expect(joined[0]!.remoteServerPublicId).toBe('pub-42');
    expect(joined[0]!.remoteServerName).toBe('Remote Server');
  });

  test('confirmJoin is idempotent (duplicate does not throw)', async () => {
    const { caller } = await initTest();
    const instance = await createTestInstance();

    const input = {
      instanceDomain: instance.domain,
      remoteServerId: 42,
      remoteServerPublicId: 'pub-42',
      remoteServerName: 'Remote Server'
    };

    await caller.federation.confirmJoin(input);
    await caller.federation.confirmJoin(input);

    const joined = await caller.federation.getJoined();
    expect(joined).toHaveLength(1);
  });

  test('confirmJoin throws for non-active instance', async () => {
    const { caller } = await initTest();

    // Create a pending (non-active) instance
    await db.insert(federationInstances).values({
      domain: 'pending.example.com',
      name: 'Pending Instance',
      status: 'pending',
      direction: 'outgoing',
      createdAt: Date.now()
    });

    await expect(
      caller.federation.confirmJoin({
        instanceDomain: 'pending.example.com',
        remoteServerId: 1,
        remoteServerPublicId: 'pub-1',
        remoteServerName: 'Server'
      })
    ).rejects.toThrow();
  });

  test('getJoined returns only memberships for the calling user', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const instance = await createTestInstance();

    await caller1.federation.confirmJoin({
      instanceDomain: instance.domain,
      remoteServerId: 10,
      remoteServerPublicId: 'pub-10',
      remoteServerName: 'Server A'
    });

    await caller2.federation.confirmJoin({
      instanceDomain: instance.domain,
      remoteServerId: 20,
      remoteServerPublicId: 'pub-20',
      remoteServerName: 'Server B'
    });

    const joined1 = await caller1.federation.getJoined();
    expect(joined1).toHaveLength(1);
    expect(joined1[0]!.remoteServerId).toBe(10);

    const joined2 = await caller2.federation.getJoined();
    expect(joined2).toHaveLength(1);
    expect(joined2[0]!.remoteServerId).toBe(20);
  });

  test('getJoined excludes memberships on non-active instances', async () => {
    const { caller } = await initTest();

    // Create an active instance and join
    const activeInstance = await createTestInstance('active.example.com', 'Active');
    await caller.federation.confirmJoin({
      instanceDomain: activeInstance.domain,
      remoteServerId: 1,
      remoteServerPublicId: 'pub-1',
      remoteServerName: 'Active Server'
    });

    // Create a blocked instance and join
    const [blockedInstance] = await db
      .insert(federationInstances)
      .values({
        domain: 'blocked.example.com',
        name: 'Blocked',
        status: 'active', // must be active to confirmJoin
        direction: 'outgoing',
        createdAt: Date.now()
      })
      .returning();

    await caller.federation.confirmJoin({
      instanceDomain: blockedInstance!.domain,
      remoteServerId: 2,
      remoteServerPublicId: 'pub-2',
      remoteServerName: 'Blocked Server'
    });

    // Now block the instance
    await db
      .update(federationInstances)
      .set({ status: 'blocked' })
      .where(eq(federationInstances.id, blockedInstance!.id));

    const joined = await caller.federation.getJoined();
    expect(joined).toHaveLength(1);
    expect(joined[0]!.instanceDomain).toBe('active.example.com');
  });

  test('leaveRemote removes the membership', async () => {
    const { caller } = await initTest();
    const instance = await createTestInstance();

    await caller.federation.confirmJoin({
      instanceDomain: instance.domain,
      remoteServerId: 42,
      remoteServerPublicId: 'pub-42',
      remoteServerName: 'Remote Server'
    });

    let joined = await caller.federation.getJoined();
    expect(joined).toHaveLength(1);

    await caller.federation.leaveRemote({
      instanceDomain: instance.domain,
      remoteServerId: 42
    });

    joined = await caller.federation.getJoined();
    expect(joined).toHaveLength(0);
  });

  test('leaveRemote is safe when no membership exists', async () => {
    const { caller } = await initTest();
    await createTestInstance();

    // Should not throw
    await caller.federation.leaveRemote({
      instanceDomain: 'remote.example.com',
      remoteServerId: 999
    });
  });

  test('multiple servers on same instance are tracked independently', async () => {
    const { caller } = await initTest();
    const instance = await createTestInstance();

    await caller.federation.confirmJoin({
      instanceDomain: instance.domain,
      remoteServerId: 1,
      remoteServerPublicId: 'pub-1',
      remoteServerName: 'Server A'
    });

    await caller.federation.confirmJoin({
      instanceDomain: instance.domain,
      remoteServerId: 2,
      remoteServerPublicId: 'pub-2',
      remoteServerName: 'Server B'
    });

    let joined = await caller.federation.getJoined();
    expect(joined).toHaveLength(2);

    // Leave only one
    await caller.federation.leaveRemote({
      instanceDomain: instance.domain,
      remoteServerId: 1
    });

    joined = await caller.federation.getJoined();
    expect(joined).toHaveLength(1);
    expect(joined[0]!.remoteServerId).toBe(2);
  });
});
