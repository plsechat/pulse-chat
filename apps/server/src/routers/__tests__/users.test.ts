import { ServerEvents, type TTempFile } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken, initTest, uploadFile } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { appRouter } from '../../routers';
import { pubsub } from '../../utils/pubsub';

describe('users router', () => {
  test('should throw when user lacks permissions (getAll)', async () => {
    const { caller } = await initTest(2);

    await expect(caller.users.getAll()).rejects.toThrow(
      'Insufficient permissions'
    );
  });

  test('should throw when user lacks permissions (getInfo)', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.users.getInfo({
        userId: 1
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should throw when user lacks permissions (ban)', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.users.ban({
        userId: 1,
        reason: 'Test ban'
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should throw when user lacks permissions (unban)', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.users.unban({
        userId: 1
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should throw when user lacks permissions (kick)', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.users.kick({
        userId: 1,
        reason: 'Test kick'
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should throw when user lacks permissions (addRole)', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.users.addRole({
        userId: 1,
        roleId: 2
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should throw when user lacks permissions (removeRole)', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.users.removeRole({
        userId: 1,
        roleId: 2
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should get all users', async () => {
    const { caller } = await initTest();

    const users = await caller.users.getAll();

    expect(users).toBeDefined();
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThan(0);

    // verify sensitive fields are cleared
    users.forEach((user) => {
      expect(user.supabaseId).toBeEmpty();
    });
  });

  test('should get user info', async () => {
    const { caller } = await initTest();

    const info = await caller.users.getInfo({
      userId: 2
    });

    expect(info).toBeDefined();
    expect(info.user).toBeDefined();
    expect(info.user.id).toBe(2);
  });

  test('should throw when getting info for non-existing user', async () => {
    const { caller } = await initTest();

    await expect(
      caller.users.getInfo({
        userId: 999
      })
    ).rejects.toThrow('User not found');
  });

  test('should update own user profile', async () => {
    const { caller } = await initTest();

    await caller.users.update({
      name: 'Updated Name',
      bannerColor: '#ff0000',
      bio: 'This is my new bio'
    });

    const users = await caller.users.getAll();
    const updatedUser = users.find((u) => u.id === 1);

    expect(updatedUser).toBeDefined();
    expect(updatedUser!.name).toBe('Updated Name');
    expect(updatedUser!.bannerColor).toBe('#ff0000');
    expect(updatedUser!.bio).toBe('This is my new bio');
  });

  test('should update user profile with null bio', async () => {
    const { caller } = await initTest();

    await caller.users.update({
      name: 'Updated Owner',
      bannerColor: '#00ff00'
    });

    const users = await caller.users.getAll();
    const updatedUser = users.find((u) => u.id === 1);

    expect(updatedUser).toBeDefined();
    expect(updatedUser!.name).toBe('Updated Owner');
    expect(updatedUser!.bannerColor).toBe('#00ff00');
  });

  test('should update password successfully', async () => {
    const { caller } = await initTest();

    const currentPassword = 'password123';
    const newPassword = 'newpassword456';

    // Password is now managed by Supabase Auth, so we just verify the mutation doesn't throw
    await caller.users.updatePassword({
      currentPassword,
      newPassword,
      confirmNewPassword: newPassword
    });
  });

  test('should throw when current password is incorrect', async () => {
    const { caller } = await initTest();

    await expect(
      caller.users.updatePassword({
        currentPassword: 'wrongpassword',
        newPassword: 'newpassword',
        confirmNewPassword: 'newpassword'
      })
    ).rejects.toThrow('Current password is incorrect');
  });

  test('should throw when new passwords do not match', async () => {
    const { caller } = await initTest();

    await expect(
      caller.users.updatePassword({
        currentPassword: 'password123',
        newPassword: 'newpassword',
        confirmNewPassword: 'differentpassword'
      })
    ).rejects.toThrow('New password and confirmation do not match');
  });

  test('getAuthProviders should return identities from supabase', async () => {
    const { caller } = await initTest();

    const result = await caller.users.getAuthProviders();
    expect(result.providers).toContain('email');
  });

  test('updatePassword should reject OAuth-only users (no email identity)', async () => {
    const { caller } = await initTest();

    // Mutate the seeded auth-store entry to drop the email provider —
    // simulates a user who signed up via Google/GitHub and never set
    // a password. Without the gate, signInWithPassword would fail with
    // "current password incorrect," which is misleading. The gate
    // should reject earlier with a clear message naming the linked
    // provider.
    const store = globalThis.__supabaseAuthStore!;
    for (const entry of store.values()) {
      entry.identities = ['google'];
    }

    await expect(
      caller.users.updatePassword({
        currentPassword: 'password123',
        newPassword: 'newpassword',
        confirmNewPassword: 'newpassword'
      })
    ).rejects.toThrow('signs in through google');
  });

  test('getAuthProviders should reflect non-email providers', async () => {
    const { caller } = await initTest();

    const store = globalThis.__supabaseAuthStore!;
    for (const entry of store.values()) {
      entry.identities = ['github'];
    }

    const result = await caller.users.getAuthProviders();
    expect(result.providers).toEqual(['github']);
    expect(result.providers).not.toContain('email');
  });

  test('should change avatar', async () => {
    const { caller, mockedToken } = await initTest();

    const currentUserInfo = await caller.users.getInfo({ userId: 1 });

    expect(currentUserInfo).toBeDefined();
    expect(currentUserInfo.user.avatarId).toBeNull();

    const file = new File(['avatar content'], 'avatar.png', {
      type: 'image/png'
    });

    const uploadResponse = await uploadFile(file, mockedToken);
    const uploadData = (await uploadResponse.json()) as TTempFile;

    await caller.users.changeAvatar({
      fileId: uploadData.id
    });

    const userInfo = await caller.users.getInfo({ userId: 1 });

    expect(userInfo).toBeDefined();
    expect(userInfo!.user.avatarId).toBeDefined();
  });

  test('should remove avatar', async () => {
    const { caller, mockedToken } = await initTest();

    const currentUserInfo = await caller.users.getInfo({ userId: 1 });

    expect(currentUserInfo).toBeDefined();
    expect(currentUserInfo.user.avatarId).toBeNull();

    const file = new File(['avatar content'], 'avatar.png', {
      type: 'image/png'
    });

    const uploadResponse = await uploadFile(file, mockedToken);
    const uploadData = (await uploadResponse.json()) as TTempFile;

    await caller.users.changeAvatar({
      fileId: uploadData.id
    });

    await caller.users.changeAvatar({});

    const userInfo = await caller.users.getInfo({ userId: 1 });

    expect(userInfo).toBeDefined();
    expect(userInfo!.user.avatarId).toBeNull();
  });

  test('should change banner', async () => {
    const { caller, mockedToken } = await initTest();

    const file = new File(['banner content'], 'banner.png', {
      type: 'image/png'
    });

    const uploadResponse = await uploadFile(file, mockedToken);
    const uploadData = (await uploadResponse.json()) as TTempFile;

    await caller.users.changeBanner({
      fileId: uploadData.id
    });

    const userInfo = await caller.users.getInfo({ userId: 1 });

    expect(userInfo).toBeDefined();
    expect(userInfo!.user.bannerId).toBeDefined();
  });

  test('should remove banner', async () => {
    const { caller, mockedToken } = await initTest();

    const file = new File(['banner content'], 'banner.png', {
      type: 'image/png'
    });

    const uploadResponse = await uploadFile(file, mockedToken);
    const uploadData = (await uploadResponse.json()) as TTempFile;

    await caller.users.changeBanner({
      fileId: uploadData.id
    });

    await caller.users.changeBanner({});

    const userInfo = await caller.users.getInfo({ userId: 1 });

    expect(userInfo).toBeDefined();
    expect(userInfo!.user.bannerId).toBeNull();
  });

  test('should replace existing avatar', async () => {
    const { caller, mockedToken } = await initTest();

    const file1 = new File(['first avatar'], 'avatar1.png', {
      type: 'image/png'
    });

    const uploadResponse1 = await uploadFile(file1, mockedToken);
    const uploadData1 = (await uploadResponse1.json()) as TTempFile;

    await caller.users.changeAvatar({
      fileId: uploadData1.id
    });

    const firstInfo = await caller.users.getInfo({ userId: 1 });
    const firstAvatarId = firstInfo.user.avatarId;

    const file2 = new File(['second avatar'], 'avatar2.png', {
      type: 'image/png'
    });

    const uploadResponse2 = await uploadFile(file2, mockedToken);
    const uploadData2 = (await uploadResponse2.json()) as TTempFile;

    await caller.users.changeAvatar({
      fileId: uploadData2.id
    });

    const secondInfo = await caller.users.getInfo({ userId: 1 });

    expect(secondInfo.user.avatarId).not.toBe(firstAvatarId);
  });

  test('should add role to user', async () => {
    const { caller } = await initTest();

    // roleId 3 is the test seed's "Guest" role. Avoid roleId 1 because
    // the OWNER_ROLE_ID grant block in add-role.ts now refuses it.
    await caller.users.addRole({
      userId: 2,
      roleId: 3
    });

    const info = await caller.users.getInfo({
      userId: 2
    });

    expect(info.user.roleIds).toContain(3);
  });

  test('should throw when adding duplicate role', async () => {
    const { caller } = await initTest();

    await expect(
      caller.users.addRole({
        userId: 2,
        roleId: 2
      })
    ).rejects.toThrow('User already has this role');
  });

  test('should remove role from user', async () => {
    const { caller } = await initTest();

    // roleId 3 is the Guest role (see "should add role to user" comment).
    await caller.users.addRole({
      userId: 2,
      roleId: 3
    });

    await caller.users.removeRole({
      userId: 2,
      roleId: 3
    });

    const info = await caller.users.getInfo({
      userId: 2
    });

    expect(info.user.roleIds).not.toContain(3);
  });

  test('should throw when removing non-existent role', async () => {
    const { caller } = await initTest();

    await expect(
      caller.users.removeRole({
        userId: 2,
        roleId: 3
      })
    ).rejects.toThrow('User does not have this role');
  });

  test('should ban user with reason', async () => {
    const { caller } = await initTest();

    await caller.users.ban({
      userId: 2,
      reason: 'Violated community guidelines'
    });

    const info = await caller.users.getInfo({
      userId: 2
    });

    expect(info.user.banned).toBe(true);
    expect(info.user.banReason).toBe('Violated community guidelines');
    expect(info.user.bannedAt).toBeDefined();
  });

  test('should ban user without reason', async () => {
    const { caller } = await initTest();

    await caller.users.ban({
      userId: 2
    });

    const info = await caller.users.getInfo({
      userId: 2
    });

    expect(info.user.banned).toBe(true);
    expect(info.user.banReason).toBeNull();
  });

  test('should throw when trying to ban yourself', async () => {
    const { caller } = await initTest();

    await expect(
      caller.users.ban({
        userId: 1
      })
    ).rejects.toThrow('You cannot ban yourself');
  });

  test('should unban user', async () => {
    const { caller } = await initTest();

    await caller.users.ban({
      userId: 2,
      reason: 'Test'
    });

    await caller.users.unban({
      userId: 2
    });

    const info = await caller.users.getInfo({
      userId: 2
    });

    expect(info.user.banned).toBe(false);
    expect(info.user.banReason).toBeNull();
  });

  test('should throw when kicking non-member user', async () => {
    // Build a caller with activeServerId pre-set so the kick route's
    // invariant(ctx.activeServerId) passes before reaching the membership check.
    const mockedToken = await getMockedToken(1);
    const ctx = await createMockContext({ customToken: mockedToken });
    ctx.authenticated = true;
    ctx.activeServerId = 1;
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.users.kick({
        userId: 999
      })
    ).rejects.toThrow('User is not a member of this server');
  });

  test('kick publishes events carrying the server publicId', async () => {
    // Federation ID-collision guard: numeric server ids are instance-local
    // and collide across federated instances, so USER_KICKED /
    // SERVER_MEMBER_LEAVE / USER_DELETE must carry the globally-unique
    // serverPublicId for the client to scope them safely.
    const { caller } = await initTest(1);
    const tdb = getTestDb();

    const [serverRow] = (await tdb.execute(
      sql`SELECT public_id FROM servers WHERE id = 1`
    )) as unknown as { public_id: string }[];
    expect(serverRow?.public_id).toBeTruthy();

    const publishedEvents: { topic: string; payload: unknown }[] = [];
    const original = pubsub.publishFor.bind(pubsub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publishFor = (
      userIds: unknown,
      topic: string,
      payload: unknown
    ) => {
      publishedEvents.push({ topic, payload });
      return original(userIds as never, topic as never, payload as never);
    };

    try {
      await caller.users.kick({ userId: 2, reason: 'test kick' });
      // publishUser (USER_DELETE) is fire-and-forget — give it a beat
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pubsub as any).publishFor = original;
    }

    const byTopic = (topic: string) =>
      publishedEvents.filter((e) => e.topic === topic);

    const kicked = byTopic(ServerEvents.USER_KICKED);
    expect(kicked.length).toBe(1);
    expect(kicked[0]!.payload).toMatchObject({
      serverId: 1,
      serverPublicId: serverRow!.public_id,
      reason: 'test kick'
    });

    const memberLeave = byTopic(ServerEvents.SERVER_MEMBER_LEAVE);
    expect(memberLeave.length).toBe(1);
    expect(memberLeave[0]!.payload).toMatchObject({
      serverId: 1,
      serverPublicId: serverRow!.public_id,
      userId: 2
    });

    const userDelete = byTopic(ServerEvents.USER_DELETE);
    expect(userDelete.length).toBe(1);
    expect(userDelete[0]!.payload).toMatchObject({
      serverId: 1,
      serverPublicId: serverRow!.public_id,
      userId: 2
    });
  });

  test('setCustomStatus persists, publishes, and clears', async () => {
    const { caller } = await initTest(1);
    const tdb = getTestDb();

    await caller.users.setCustomStatus({ customStatus: '🎧 working late' });

    const [row] = (await tdb.execute(
      sql`SELECT custom_status FROM users WHERE id = 1`
    )) as unknown as { custom_status: string | null }[];
    expect(row?.custom_status).toBe('🎧 working late');

    // Clearing with null wipes it
    await caller.users.setCustomStatus({ customStatus: null });
    const [cleared] = (await tdb.execute(
      sql`SELECT custom_status FROM users WHERE id = 1`
    )) as unknown as { custom_status: string | null }[];
    expect(cleared?.custom_status).toBeNull();
  });

  test('setCustomStatus rejects over-length text', async () => {
    const { caller } = await initTest(1);
    await expect(
      caller.users.setCustomStatus({ customStatus: 'x'.repeat(129) })
    ).rejects.toThrow();
  });

  test('joinServer publishes USER_JOIN carrying the server publicId', async () => {
    const publishedEvents: { topic: string; payload: unknown }[] = [];
    const original = pubsub.publishFor.bind(pubsub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publishFor = (
      userIds: unknown,
      topic: string,
      payload: unknown
    ) => {
      publishedEvents.push({ topic, payload });
      return original(userIds as never, topic as never, payload as never);
    };

    try {
      await initTest(2);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pubsub as any).publishFor = original;
    }

    const tdb = getTestDb();
    const [serverRow] = (await tdb.execute(
      sql`SELECT public_id FROM servers WHERE id = 1`
    )) as unknown as { public_id: string }[];

    const joins = publishedEvents.filter(
      (e) => e.topic === ServerEvents.USER_JOIN
    );
    expect(joins.length).toBe(1);
    expect(joins[0]!.payload).toMatchObject({
      serverId: 1,
      serverPublicId: serverRow!.public_id
    });
  });

  test('should handle multiple role operations', async () => {
    const tdb = getTestDb();
    const now = Date.now();

    // Need a second non-owner role to test "add multiple, remove one,
    // verify the other remains". The seed has Owner(1)/Member(2)/Guest(3);
    // since OWNER_ROLE_ID can no longer be granted via add-role, create
    // a fresh test role on serverId=1.
    const [extraRole] = await tdb.execute(sql`
      INSERT INTO roles (name, color, is_persistent, is_default, server_id, created_at)
      VALUES ('Test Extra Role', '#abcdef', false, false, 1, ${now})
      RETURNING id
    `);
    const extraRoleId = (extraRole as { id: number }).id;

    const { caller } = await initTest();

    await caller.users.addRole({
      userId: 2,
      roleId: extraRoleId
    });

    await caller.users.addRole({
      userId: 2,
      roleId: 3
    });

    const info = await caller.users.getInfo({
      userId: 2
    });

    expect(info.user.roleIds).toContain(extraRoleId);
    expect(info.user.roleIds).toContain(3);

    await caller.users.removeRole({
      userId: 2,
      roleId: extraRoleId
    });

    const updatedInfo = await caller.users.getInfo({
      userId: 2
    });

    expect(updatedInfo.user.roleIds).not.toContain(extraRoleId);
    expect(updatedInfo.user.roleIds).toContain(3);
  });

  test('should allow valid hex colors (3 and 6 digits)', async () => {
    const { caller } = await initTest();

    await caller.users.update({
      name: 'Test',
      bannerColor: '#abc123'
    });

    let info = await caller.users.getInfo({ userId: 1 });

    expect(info.user.bannerColor).toBe('#abc123');

    await caller.users.update({
      name: 'Test',
      bannerColor: '#f0f'
    });

    info = await caller.users.getInfo({ userId: 1 });

    expect(info.user.bannerColor).toBe('#f0f');
  });

  test('should handle bio with special characters', async () => {
    const { caller } = await initTest();

    const specialBio = 'Hello! 👋 This is my bio with émojis & spëcial çhars';

    await caller.users.update({
      name: 'Bio Test Owner',
      bannerColor: '#000000',
      bio: specialBio
    });

    const info = await caller.users.getInfo({ userId: 1 });

    expect(info.user.bio).toBe(specialBio);
  });

  test('should handle multiple profile updates in sequence', async () => {
    const { caller } = await initTest();

    await caller.users.update({
      name: 'Name 1',
      bannerColor: '#111111',
      bio: 'Bio 1'
    });

    await caller.users.update({
      name: 'Name 2',
      bannerColor: '#222222',
      bio: 'Bio 2'
    });

    await caller.users.update({
      name: 'Final Name',
      bannerColor: '#333333',
      bio: 'Final Bio'
    });

    const info = await caller.users.getInfo({ userId: 1 });

    expect(info.user.name).toBe('Final Name');
    expect(info.user.bannerColor).toBe('#333333');
    expect(info.user.bio).toBe('Final Bio');
  });

  describe('getMyId', () => {
    test('returns the calling user id (user 1)', async () => {
      const { caller } = await initTest();
      const result = await caller.users.getMyId();
      expect(result).toEqual({ userId: 1 });
    });

    test('returns the calling user id (user 2)', async () => {
      const { caller } = await initTest(2);
      const result = await caller.users.getMyId();
      expect(result).toEqual({ userId: 2 });
    });
  });

  // Federated moderation (supersedes the F9 blanket guard): roles are
  // purely local state and were never a drift risk; kick/ban now work
  // locally AND propagate to the target's home instance via
  // /federation/member-removed (fire-and-forget, no-op with federation
  // disabled — as it is in this test config).
  describe('federated member moderation', () => {
    async function insertFederatedShadow(opts?: {
      member?: boolean;
    }): Promise<number> {
      const tdb = getTestDb();
      const instanceRows = (await tdb.execute(
        sql`INSERT INTO federation_instances (domain, name, status, direction, created_at) VALUES ('peer.example.com', 'Peer', 'active', 'outgoing', ${Date.now()}) RETURNING id`
      )) as unknown as Array<{ id: number }>;
      const instanceId = instanceRows[0]!.id;

      const supabaseId = `federated:${instanceId}:99`;
      const now = Date.now();
      const userRows = (await tdb.execute(
        sql`INSERT INTO users (supabase_id, name, is_federated, federated_instance_id, federated_username, public_id, federated_public_id, created_at, last_login_at) VALUES (${supabaseId}, 'shadow-user', TRUE, ${instanceId}, '99', ${`pid-${now}`}, ${`home-pid-${now}`}, ${now}, ${now}) RETURNING id`
      )) as unknown as Array<{ id: number }>;
      const shadowId = userRows[0]!.id;

      if (opts?.member) {
        await tdb.execute(
          sql`INSERT INTO server_members (server_id, user_id, joined_at) VALUES (1, ${shadowId}, ${now})`
        );
      }

      return shadowId;
    }

    test('ban works on a federated member', async () => {
      const { caller } = await initTest();
      const tdb = getTestDb();
      const shadowId = await insertFederatedShadow({ member: true });

      await caller.users.ban({ userId: shadowId, reason: 'spam' });

      const [row] = (await tdb.execute(
        sql`SELECT banned, ban_reason FROM users WHERE id = ${shadowId}`
      )) as unknown as Array<{ banned: boolean; ban_reason: string | null }>;
      expect(row?.banned).toBe(true);
      expect(row?.ban_reason).toBe('spam');
    });

    test('kick works on a federated member', async () => {
      const { caller } = await initTest();
      const tdb = getTestDb();
      const shadowId = await insertFederatedShadow({ member: true });

      await caller.users.kick({ userId: shadowId, reason: 'test kick' });

      const membership = (await tdb.execute(
        sql`SELECT user_id FROM server_members WHERE server_id = 1 AND user_id = ${shadowId}`
      )) as unknown as Array<{ user_id: number }>;
      expect(membership.length).toBe(0);
    });

    // Role assignment is deliberately EXEMPT from the federation guard
    // (v0.2.3+): userRoles rows are entirely local server state with no
    // home-instance counterpart to drift from. Ban/kick stay guarded
    // until federation propagation ships.
    test('addRole and removeRole work on federated targets', async () => {
      const { caller } = await initTest();
      const tdb = getTestDb();
      const shadowId = await insertFederatedShadow();

      await caller.users.addRole({ userId: shadowId, roleId: 2 });

      const afterAdd = (await tdb.execute(
        sql`SELECT role_id FROM user_roles WHERE user_id = ${shadowId}`
      )) as unknown as Array<{ role_id: number }>;
      expect(afterAdd.map((r) => r.role_id)).toContain(2);

      await caller.users.removeRole({ userId: shadowId, roleId: 2 });

      const afterRemove = (await tdb.execute(
        sql`SELECT role_id FROM user_roles WHERE user_id = ${shadowId}`
      )) as unknown as Array<{ role_id: number }>;
      expect(afterRemove.length).toBe(0);
    });

    test('addRole still refuses the Owner role for federated targets', async () => {
      const { caller } = await initTest();
      const shadowId = await insertFederatedShadow();
      await expect(
        caller.users.addRole({ userId: shadowId, roleId: 1 })
      ).rejects.toThrow(/Owner role/i);
    });
  });
});
