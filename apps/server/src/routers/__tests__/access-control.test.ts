import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';
import {
  createTestCategory,
  createTestChannel,
  createTestServer,
  createTestUser
} from '../../__tests__/fixtures';

/**
 * Creates a user that does NOT share any server with user 1.
 * Returns the new user's ID.
 */
async function createIsolatedUser(name: string) {
  return createTestUser({ name });
}

describe('DM creation access control', () => {
  test('should deny creating DM with a user who shares no server', async () => {
    const isolatedId = await createIsolatedUser('DM Isolated User');

    const { caller } = await initTest(1);

    await expect(
      caller.dms.getOrCreateChannel({ userId: isolatedId })
    ).rejects.toThrow('You must share a server or be friends to start a DM');
  });

  test('should allow creating DM with a user who shares a server', async () => {
    // User 2 is a member of the same server as user 1
    const { caller } = await initTest(1);

    const channel = await caller.dms.getOrCreateChannel({ userId: 2 });
    expect(channel).toBeDefined();
    expect(channel.id).toBeGreaterThan(0);
  });
});

describe('friend request access control', () => {
  test('should deny sending friend request to user who shares no server', async () => {
    const isolatedId = await createIsolatedUser('Friend Isolated User');

    const { caller } = await initTest(1);

    await expect(
      caller.friends.sendRequest({ userId: isolatedId })
    ).rejects.toThrow('You must share a server to send a friend request');
  });

  test('should allow sending friend request to user in same server', async () => {
    // User 3 is a member of the same server as user 1
    const { caller } = await initTest(1);

    const requestId = await caller.friends.sendRequest({ userId: 3 });
    expect(requestId).toBeGreaterThan(0);
  });
});

describe('get visible users access control', () => {
  test('should deny querying visible users for a channel in another server', async () => {
    const server2Id = await createTestServer({
      name: 'Isolated Server',
      ownerId: 2
    });
    const catId = await createTestCategory({
      serverId: server2Id,
      name: 'Cat'
    });
    const channelId = await createTestChannel({
      serverId: server2Id,
      categoryId: catId,
      name: 'isolated-channel'
    });

    // User 1 is NOT a member of server2
    const { caller } = await initTest(1);

    await expect(
      caller.channels.getVisibleUsers({ channelId })
    ).rejects.toThrow('Insufficient channel permissions');
  });
});

describe('getCoMemberIds and sharesServerWith', () => {
  test('sharesServerWith returns true for users in same server', async () => {
    // We test via the DM creation route which uses sharesServerWith internally
    // User 1 and User 2 share server 1
    const { caller } = await initTest(1);

    // If they share a server, DM creation should succeed
    const channel = await caller.dms.getOrCreateChannel({ userId: 2 });
    expect(channel).toBeDefined();
  });

  test('sharesServerWith returns false for isolated users', async () => {
    const isolatedId = await createIsolatedUser('Shares Test User');

    const { caller } = await initTest(1);

    // If they don't share a server, DM creation should fail
    await expect(
      caller.dms.getOrCreateChannel({ userId: isolatedId })
    ).rejects.toThrow('You must share a server or be friends to start a DM');
  });
});
