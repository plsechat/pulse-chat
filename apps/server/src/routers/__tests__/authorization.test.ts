import { Permission } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { initTest } from '../../__tests__/helpers';

/**
 * Creates a second server with its own category, channel, and roles.
 * User 1 (owner of server 1) is NOT a member of server 2.
 * User 2 (regular member of server 1) becomes the owner of server 2.
 */
async function createSecondServer() {
  const tdb = getTestDb();
  const now = Date.now();

  const [server2] = await tdb.execute(sql`
    INSERT INTO servers (name, description, password, public_id, secret_token,
      allow_new_users, storage_uploads_enabled, storage_quota,
      storage_upload_max_file_size, storage_space_quota_by_user,
      storage_overflow_action, enable_plugins, owner_id, created_at)
    VALUES ('Server 2', 'Second test server', '', ${randomUUIDv7()},
      'secret', true, true, 10737418240, 26214400, 104857600, 'reject', false,
      2, ${now})
    RETURNING id
  `);

  const server2Id = (server2 as { id: number }).id;

  // Create category in server 2
  const [cat2] = await tdb.execute(sql`
    INSERT INTO categories (name, position, server_id, created_at)
    VALUES ('Server 2 Category', 1, ${server2Id}, ${now})
    RETURNING id
  `);

  const category2Id = (cat2 as { id: number }).id;

  // Create channel in server 2
  const [ch2] = await tdb.execute(sql`
    INSERT INTO channels (type, name, position, file_access_token,
      file_access_token_updated_at, category_id, server_id, created_at)
    VALUES ('text', 'server2-general', 0, ${randomUUIDv7()}, ${now},
      ${category2Id}, ${server2Id}, ${now})
    RETURNING id
  `);

  const channel2Id = (ch2 as { id: number }).id;

  // Create owner role for server 2 with all permissions
  const [role2] = await tdb.execute(sql`
    INSERT INTO roles (name, color, is_persistent, is_default, server_id, created_at)
    VALUES ('Server2 Owner', '#ff0000', true, false, ${server2Id}, ${now})
    RETURNING id
  `);

  const role2Id = (role2 as { id: number }).id;

  // Grant all permissions to server 2 owner role
  for (const perm of Object.values(Permission)) {
    await tdb.execute(sql`
      INSERT INTO role_permissions (role_id, permission, created_at)
      VALUES (${role2Id}, ${perm}, ${now})
    `);
  }

  // Make user 2 a member and owner of server 2
  await tdb.execute(sql`
    INSERT INTO server_members (server_id, user_id, joined_at, position)
    VALUES (${server2Id}, 2, ${now}, 0)
  `);

  await tdb.execute(sql`
    INSERT INTO user_roles (user_id, role_id, created_at)
    VALUES (2, ${role2Id}, ${now})
  `);

  return { server2Id, category2Id, channel2Id, role2Id };
}

describe('cross-server authorization', () => {
  test('should deny deleting a channel from another server', async () => {
    const { channel2Id } = await createSecondServer();

    // User 1 is owner of server 1, NOT a member of server 2
    const { caller } = await initTest(1);

    // Try to delete server 2's channel while connected to server 1
    await expect(
      caller.channels.delete({ channelId: channel2Id })
    ).rejects.toThrow('Channel not found');
  });

  test('should deny updating a channel from another server', async () => {
    const { channel2Id } = await createSecondServer();

    const { caller } = await initTest(1);

    await expect(
      caller.channels.update({
        channelId: channel2Id,
        name: 'hacked'
      })
    ).rejects.toThrow();
  });

  test('should deny assigning a role from another server', async () => {
    const { role2Id } = await createSecondServer();

    // User 1 (owner of server 1) tries to assign server 2's role
    const { caller } = await initTest(1);

    await expect(
      caller.users.addRole({
        userId: 3, // user 3 is a member of server 1
        roleId: role2Id // role from server 2
      })
    ).rejects.toThrow('Role not found');
  });

  test('should deny removing a role from another server', async () => {
    const { role2Id } = await createSecondServer();

    const { caller } = await initTest(1);

    await expect(
      caller.users.removeRole({
        userId: 2,
        roleId: role2Id
      })
    ).rejects.toThrow('Role not found');
  });

  test('should deny banning a user not in the active server', async () => {
    await createSecondServer();

    // Create a user that only exists in server 2
    const tdb = getTestDb();
    const now = Date.now();

    const [user4] = await tdb.execute(sql`
      INSERT INTO users (name, supabase_id, public_id, created_at, last_login_at)
      VALUES ('Server2 Only User', ${`s2-only-${randomUUIDv7()}`}, ${randomUUIDv7()}, ${now}, ${now})
      RETURNING id
    `);

    const user4Id = (user4 as { id: number }).id;

    const { caller } = await initTest(1);

    // User 1 (server 1 owner) tries to ban a user that's not in server 1
    await expect(
      caller.users.ban({ userId: user4Id })
    ).rejects.toThrow('User not found');
  });

  test('should deny viewing user info for non-member of active server', async () => {
    await createSecondServer();

    const tdb = getTestDb();
    const now = Date.now();

    const [user4] = await tdb.execute(sql`
      INSERT INTO users (name, supabase_id, public_id, created_at, last_login_at)
      VALUES ('Server2 Only User2', ${`s2-only2-${randomUUIDv7()}`}, ${randomUUIDv7()}, ${now}, ${now})
      RETURNING id
    `);

    const user4Id = (user4 as { id: number }).id;

    const { caller } = await initTest(1);

    await expect(
      caller.users.getInfo({ userId: user4Id })
    ).rejects.toThrow('User not found');
  });

  test('should deny reordering channels from another server', async () => {
    const { category2Id, channel2Id } = await createSecondServer();

    const { caller } = await initTest(1);

    // Reorder should silently fail — the category check should reject
    await expect(
      caller.channels.reorder({
        categoryId: category2Id,
        channelIds: [channel2Id]
      })
    ).rejects.toThrow('Category not found');
  });
});

describe('message search scoping', () => {
  test('should only return messages from the active server', async () => {
    const { channel2Id } = await createSecondServer();

    // Add a message to server 2's channel
    const tdb = getTestDb();
    await tdb.execute(sql`
      INSERT INTO messages (user_id, channel_id, content, created_at)
      VALUES (2, ${channel2Id}, 'secret server2 message', ${Date.now()})
    `);

    // User 1 searches from server 1 — should NOT find server 2's messages
    const { caller } = await initTest(1);

    const result = await caller.search.messages({
      query: 'secret server2'
    });

    expect(result.messages).toHaveLength(0);
  });

  test('should return messages from the active server', async () => {
    const { caller } = await initTest(1);

    const result = await caller.search.messages({
      query: 'Test message'
    });

    expect(result.messages.length).toBeGreaterThan(0);
  });
});

describe('E2EE authorization', () => {
  test('should deny distributing sender keys to a channel the user cannot access', async () => {
    const { channel2Id } = await createSecondServer();

    // User 1 (server 1 owner) tries to distribute a key for server 2's channel
    const { caller } = await initTest(1);

    await expect(
      caller.e2ee.distributeSenderKey({
        channelId: channel2Id,
        toUserId: 2,
        distributionMessage: 'malicious-key'
      })
    ).rejects.toThrow();
  });

  test('should deny batch distributing sender keys to a channel the user cannot access', async () => {
    const { channel2Id } = await createSecondServer();

    const { caller } = await initTest(1);

    await expect(
      caller.e2ee.distributeSenderKeysBatch({
        channelId: channel2Id,
        distributions: [
          { toUserId: 2, distributionMessage: 'malicious-key' }
        ]
      })
    ).rejects.toThrow();
  });

  test('should deny fetching pre-key bundle for unrelated user', async () => {
    await createSecondServer();

    const tdb = getTestDb();
    const now = Date.now();

    // Create an isolated user with no shared servers
    const [isolated] = await tdb.execute(sql`
      INSERT INTO users (name, supabase_id, public_id, created_at, last_login_at)
      VALUES ('Isolated User', ${`isolated-${randomUUIDv7()}`}, ${randomUUIDv7()}, ${now}, ${now})
      RETURNING id
    `);

    const isolatedId = (isolated as { id: number }).id;

    const { caller } = await initTest(1);

    await expect(
      caller.e2ee.getPreKeyBundle({ userId: isolatedId })
    ).rejects.toThrow('No shared server with target user');
  });

  test('should deny fetching identity public key for unrelated user', async () => {
    const tdb = getTestDb();
    const now = Date.now();

    const [isolated] = await tdb.execute(sql`
      INSERT INTO users (name, supabase_id, public_id, created_at, last_login_at)
      VALUES ('Isolated User 2', ${`isolated2-${randomUUIDv7()}`}, ${randomUUIDv7()}, ${now}, ${now})
      RETURNING id
    `);

    const isolatedId = (isolated as { id: number }).id;

    const { caller } = await initTest(1);

    await expect(
      caller.e2ee.getIdentityPublicKey({ userId: isolatedId })
    ).rejects.toThrow('No shared server with target user');
  });

  test('should allow fetching pre-key bundle for user in same server', async () => {
    const { caller } = await initTest(1);

    // User 2 is in the same server - should be allowed
    const result = await caller.e2ee.getPreKeyBundle({ userId: 2 });

    // No keys registered yet, so should return null (not throw)
    expect(result).toBeNull();
  });
});

describe('webhook authorization', () => {
  test('should deny creating webhook for channel in another server', async () => {
    const { channel2Id } = await createSecondServer();

    const { caller } = await initTest(1);

    await expect(
      caller.webhooks.create({
        name: 'Malicious Webhook',
        channelId: channel2Id
      })
    ).rejects.toThrow('Channel not found');
  });

  test('should deny listing webhooks for channel in another server', async () => {
    const { channel2Id } = await createSecondServer();

    const { caller } = await initTest(1);

    await expect(
      caller.webhooks.list({
        channelId: channel2Id
      })
    ).rejects.toThrow('Channel not found');
  });
});
