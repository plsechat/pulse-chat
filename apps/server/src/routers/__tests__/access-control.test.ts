import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { initTest } from '../../__tests__/helpers';

/**
 * Creates a user that does NOT share any server with user 1.
 * Returns the new user's ID.
 */
async function createIsolatedUser(name: string) {
  const tdb = getTestDb();
  const now = Date.now();

  const [user] = await tdb.execute(sql`
    INSERT INTO users (name, supabase_id, public_id, created_at, last_login_at)
    VALUES (${name}, ${`isolated-${randomUUIDv7()}`}, ${randomUUIDv7()}, ${now}, ${now})
    RETURNING id
  `);

  return (user as { id: number }).id;
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
    const tdb = getTestDb();
    const now = Date.now();

    // Create another server with a channel
    const [server2] = await tdb.execute(sql`
      INSERT INTO servers (name, description, password, public_id, secret_token,
        allow_new_users, storage_uploads_enabled, storage_quota,
        storage_upload_max_file_size, storage_space_quota_by_user,
        storage_overflow_action, enable_plugins, owner_id, created_at)
      VALUES ('Isolated Server', '', '', ${randomUUIDv7()},
        'secret', true, true, 10737418240, 26214400, 104857600, 'reject', false,
        2, ${now})
      RETURNING id
    `);

    const server2Id = (server2 as { id: number }).id;

    const [cat] = await tdb.execute(sql`
      INSERT INTO categories (name, position, server_id, created_at)
      VALUES ('Cat', 0, ${server2Id}, ${now})
      RETURNING id
    `);

    const catId = (cat as { id: number }).id;

    const [ch] = await tdb.execute(sql`
      INSERT INTO channels (type, name, position, file_access_token,
        file_access_token_updated_at, category_id, server_id, created_at)
      VALUES ('text', 'isolated-channel', 0, ${randomUUIDv7()}, ${now},
        ${catId}, ${server2Id}, ${now})
      RETURNING id
    `);

    const channelId = (ch as { id: number }).id;

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
