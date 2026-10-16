/**
 * Account self-deletion (users.deleteAccount) — anonymize-tombstone
 * semantics: the users row survives (messages keep an author) but every
 * identifying field is scrubbed, relationship rows are removed, and the
 * auth-side identity is deleted.
 *
 * Setup is done inline in each test (no beforeEach) to avoid piling row
 * inserts onto the global setup.ts TRUNCATE in a way that competes with
 * parallel test files for table-level locks.
 */

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  activityLog,
  channelUserPermissions,
  friendships,
  logins,
  messages,
  serverMembers,
  threadFollowers,
  userBlocks,
  userKeyBackups,
  userNotes,
  userPreferences,
  userRoles,
  users
} from '../../db/schema';
import { ChannelPermission, type TUserPreferences } from '@pulse/shared';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken, initTest } from '../../__tests__/helpers';
import { appRouter } from '../index';

/** The in-memory auth store the mock backend reads (see mock-modules). */
const authStore = (
  globalThis as unknown as {
    __supabaseAuthStore: Map<
      string,
      { supabaseId: string; password: string; email: string }
    >;
  }
).__supabaseAuthStore;

/** Give a seeded user a password identity in the mock auth store. */
async function wirePasswordAuth(userId: number, email: string, password: string) {
  const [row] = await db
    .select({ supabaseId: users.supabaseId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  authStore.set(email, { supabaseId: row!.supabaseId, password, email });
  return row!.supabaseId;
}

describe('users.deleteAccount', () => {
  test('anonymizes the row, removes relationships, keeps messages', async () => {
    const { caller } = await initTest(2);

    const [before] = await db
      .select()
      .from(users)
      .where(eq(users.id, 2))
      .limit(1);

    // A message that must survive the deletion, and a friendship that
    // must not.
    await db.insert(messages).values({
      content: 'still here after deletion',
      userId: 2,
      channelId: 1,
      createdAt: Date.now()
    });
    await db
      .insert(friendships)
      .values({ userId: 2, friendId: 3, createdAt: Date.now() });

    await caller.users.deleteAccount({ confirmName: before!.name });

    const [after] = await db
      .select()
      .from(users)
      .where(eq(users.id, 2))
      .limit(1);

    expect(after!.deletedAt).toBeGreaterThan(0);
    expect(after!.name).toBe(`Deleted User ${before!.publicId.slice(0, 6)}`);
    expect(after!.supabaseId).toBe(`deleted:${before!.publicId}`);
    expect(after!.bio).toBeNull();
    expect(after!.nameplate).toBeNull();
    expect(after!.avatarDecoration).toBeNull();
    expect(after!.nameStyle).toBeNull();
    expect(after!.avatarId).toBeNull();

    const memberships = await db
      .select()
      .from(serverMembers)
      .where(eq(serverMembers.userId, 2));
    expect(memberships.length).toBe(0);

    const roles = await db
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, 2));
    expect(roles.length).toBe(0);

    const friends = await db
      .select()
      .from(friendships)
      .where(eq(friendships.userId, 2));
    expect(friends.length).toBe(0);

    const kept = await db
      .select()
      .from(messages)
      .where(eq(messages.userId, 2));
    expect(kept.length).toBe(1);
    expect(kept[0]!.content).toBe('still here after deletion');
  });

  test('rejects a wrong name confirmation', async () => {
    const { caller } = await initTest(2);

    expect(
      caller.users.deleteAccount({ confirmName: 'Not My Name' })
    ).rejects.toThrow(/does not match/);

    const [row] = await db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, 2))
      .limit(1);
    expect(row!.deletedAt).toBeNull();
  });

  test('blocks deletion while the user still owns a server', async () => {
    // User 1 is the seeded owner of server 1.
    const { caller } = await initTest(1);
    const [owner] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, 1))
      .limit(1);

    expect(
      caller.users.deleteAccount({ confirmName: owner!.name })
    ).rejects.toThrow(/own/);

    const [row] = await db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, 1))
      .limit(1);
    expect(row!.deletedAt).toBeNull();
  });

  test('password accounts must supply the correct password', async () => {
    const { caller } = await initTest(2);
    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, 2))
      .limit(1);
    await wirePasswordAuth(2, 'todelete@test.local', 'hunter22');

    // Missing password
    expect(
      caller.users.deleteAccount({ confirmName: row!.name })
    ).rejects.toThrow(/Password is required/);

    // Wrong password
    expect(
      caller.users.deleteAccount({
        confirmName: row!.name,
        password: 'wrong'
      })
    ).rejects.toThrow(/incorrect/);

    // Correct password succeeds and removes the auth-side identity
    await caller.users.deleteAccount({
      confirmName: row!.name,
      password: 'hunter22'
    });

    expect(authStore.has('todelete@test.local')).toBe(false);

    const [after] = await db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, 2))
      .limit(1);
    expect(after!.deletedAt).toBeGreaterThan(0);
  });

  test('the old token cannot open a new session after deletion', async () => {
    const { caller } = await initTest(2);
    const oldToken = await getMockedToken(2);
    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, 2))
      .limit(1);

    await caller.users.deleteAccount({ confirmName: row!.name });

    // Existing connections are force-closed by the route; what matters
    // here is that a FRESH connection with the old token can never
    // resolve a user again (the supabaseId mapping was scrubbed).
    expect(
      (async () => {
        const ctx = await createMockContext({ customToken: oldToken });
        const fresh = appRouter.createCaller(ctx);
        await fresh.users.getMyId();
      })()
    ).rejects.toThrow();
  });

  test('nobody can DM or befriend a tombstone', async () => {
    const { caller } = await initTest(2);
    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, 2))
      .limit(1);
    await caller.users.deleteAccount({ confirmName: row!.name });

    // User 3 shares no server with the tombstone (memberships were
    // removed) and is not a friend — both relationship gates refuse.
    const { caller: other } = await initTest(3);
    expect(
      other.dms.getOrCreateChannel({ userId: 2 })
    ).rejects.toThrow();
    expect(other.friends.sendRequest({ userId: 2 })).rejects.toThrow();
  });

  test('purges per-user state and PII: logins, activity ip, key backup, preferences, notes, blocks, follows, overrides', async () => {
    const { caller } = await initTest(2);
    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, 2))
      .limit(1);
    const now = Date.now();

    await db.insert(logins).values({
      userId: 2,
      ip: '203.0.113.9',
      city: 'Somewhere',
      userAgent: 'ua',
      createdAt: now
    });
    await db.insert(activityLog).values([
      { userId: 2, type: 'probe', ip: '203.0.113.9', createdAt: now },
      { userId: 3, type: 'probe', ip: '198.51.100.7', createdAt: now }
    ]);
    await db.insert(userKeyBackups).values({
      userId: 2,
      encryptedData: 'blob',
      createdAt: now,
      updatedAt: now
    });
    await db.insert(userPreferences).values({
      userId: 2,
      data: {} as TUserPreferences,
      updatedAt: now
    });
    await db.insert(userNotes).values([
      { authorId: 2, targetUserId: 3, content: 'about 3', createdAt: now },
      { authorId: 3, targetUserId: 2, content: 'about 2', createdAt: now },
      { authorId: 3, targetUserId: 1, content: 'kept', createdAt: now }
    ]);
    await db.insert(userBlocks).values([
      { blockerId: 2, blockedUserId: 3, createdAt: now },
      { blockerId: 3, blockedUserId: 2, createdAt: now },
      { blockerId: 3, blockedUserId: 1, createdAt: now }
    ]);
    await db.insert(threadFollowers).values({
      threadId: 1,
      userId: 2,
      createdAt: now
    });
    await db.insert(channelUserPermissions).values({
      channelId: 1,
      userId: 2,
      permission: ChannelPermission.VIEW_CHANNEL,
      allow: true,
      createdAt: now
    });

    await caller.users.deleteAccount({ confirmName: row!.name });

    expect(await db.select().from(logins).where(eq(logins.userId, 2))).toHaveLength(0);

    const activity = await db.select().from(activityLog);
    const own = activity.filter((a) => a.userId === 2);
    // The deletion itself logs an entry for the user; every row of theirs is ip-less.
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((a) => a.ip === null)).toBe(true);
    expect(activity.find((a) => a.userId === 3)!.ip).toBe('198.51.100.7');

    expect(await db.select().from(userKeyBackups).where(eq(userKeyBackups.userId, 2))).toHaveLength(0);
    expect(await db.select().from(userPreferences).where(eq(userPreferences.userId, 2))).toHaveLength(0);

    const notes = await db.select().from(userNotes);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toBe('kept');

    const blocks = await db.select().from(userBlocks);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ blockerId: 3, blockedUserId: 1 });

    expect(await db.select().from(threadFollowers).where(eq(threadFollowers.userId, 2))).toHaveLength(0);
    expect(
      await db.select().from(channelUserPermissions).where(eq(channelUserPermissions.userId, 2))
    ).toHaveLength(0);
  });
});
