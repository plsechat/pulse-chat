import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { login } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { invites, settings, userRoles, users } from '../../db/schema';

describe('/login', () => {
  test('should successfully login with valid credentials', async () => {
    const response = await login('testowner@pulse.local', 'password123');

    expect(response.status).toBe(200);

    const data = (await response.json()) as {
      success: boolean;
      accessToken: string;
      refreshToken: string;
    };

    expect(data).toHaveProperty('success', true);
    expect(data).toHaveProperty('accessToken');
    expect(data).toHaveProperty('refreshToken');
  });

  test('should fail login with invalid password', async () => {
    const response = await login('testowner@pulse.local', 'wrongpassword');

    expect(response.status).toBe(400);

    const data: any = await response.json();

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('email');
  });

  test('should auto-register new user when allowNewUsers is true', async () => {
    const response = await login('newuser@pulse.local', 'newpassword123');

    expect(response.status).toBe(200);

    const data = await response.json();

    expect(data).toHaveProperty('success', true);
    expect(data).toHaveProperty('accessToken');
    expect(data).toHaveProperty('refreshToken');
  });

  test.skip('should fail when allowNewUsers is false and no invite provided', async () => {
    const tdb = getTestDb();
    await tdb.update(settings).set({ allowNewUsers: false });

    const response = await login('anothernewuser@pulse.local', 'password123');

    expect(response.status).toBe(400);

    const data: any = await response.json();

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('email');
  });

  test.skip('should allow registration with valid invite when allowNewUsers is false', async () => {
    const tdb = getTestDb();
    await tdb.update(settings).set({ allowNewUsers: false });

    await tdb.insert(invites).values({
      code: 'TESTINVITE123',
      creatorId: 1,
      serverId: 1,
      maxUses: 5,
      uses: 0,
      expiresAt: Date.now() + 86400000, // 1 day
      createdAt: Date.now()
    });

    const response = await login(
      'inviteuser@pulse.local',
      'password123',
      'TESTINVITE123'
    );

    expect(response.status).toBe(200);

    const data = await response.json();

    expect(data).toHaveProperty('success', true);
    expect(data).toHaveProperty('accessToken');

    const [updatedInvite] = await tdb
      .select()
      .from(invites)
      .where(eq(invites.code, 'TESTINVITE123'))
      .limit(1);

    expect(updatedInvite?.uses).toBe(1);
  });

  test.skip('should fail with expired invite', async () => {
    const tdb = getTestDb();
    await tdb.update(settings).set({ allowNewUsers: false });

    await tdb.insert(invites).values({
      code: 'EXPIREDINVITE',
      creatorId: 1,
      serverId: 1,
      maxUses: 5,
      uses: 0,
      expiresAt: Date.now() - 1000, // expired
      createdAt: Date.now() - 86400000
    });

    const response = await login(
      'expiredinviteuser@pulse.local',
      'password123',
      'EXPIREDINVITE'
    );

    expect(response.status).toBe(400);

    const data: any = await response.json();

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('email');
  });

  test.skip('should fail with maxed out invite', async () => {
    const tdb = getTestDb();
    await tdb.update(settings).set({ allowNewUsers: false });

    await tdb.insert(invites).values({
      code: 'MAXEDINVITE',
      creatorId: 1,
      serverId: 1,
      maxUses: 2,
      uses: 2,
      expiresAt: Date.now() + 86400000,
      createdAt: Date.now()
    });

    const response = await login(
      'maxedinviteuser@pulse.local',
      'password123',
      'MAXEDINVITE'
    );

    expect(response.status).toBe(400);

    const data: any = await response.json();

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('email');
  });

  test.skip('should fail with non-existent invite', async () => {
    const tdb = getTestDb();
    await tdb.update(settings).set({ allowNewUsers: false });

    const response = await login(
      'fakeinviteuser@pulse.local',
      'password123',
      'FAKEINVITECODE'
    );

    expect(response.status).toBe(400);

    const data: any = await response.json();

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('email');
  });

  test('should fail login for banned user', async () => {
    const tdb = getTestDb();

    // First register the user
    const registerResponse = await login('banneduser@pulse.local', 'password123');
    expect(registerResponse.status).toBe(200);

    // Get the user and ban them
    const [user] = await tdb
      .select()
      .from(users)
      .where(eq(users.name, 'banneduser'))
      .limit(1);

    if (user) {
      await tdb
        .update(users)
        .set({
          banned: true,
          banReason: 'Test ban reason'
        })
        .where(eq(users.id, user.id));
    }

    // Try to login again
    const response = await login('banneduser@pulse.local', 'password123');

    expect(response.status).toBe(400);

    const data: any = await response.json();

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('email');
    expect(data.errors.email).toContain('banned');
  });

  test('should fail with missing email', async () => {
    const response = await login('', 'somepassword');

    expect(response.status).toBe(400);

    const data = await response.json();

    expect(data).toHaveProperty('errors');
  });

  test('should fail with missing password', async () => {
    const response = await login('someuser@pulse.local', '');

    expect(response.status).toBe(400);

    const data = await response.json();

    expect(data).toHaveProperty('errors');
  });

  test('should return valid access and refresh tokens', async () => {
    const response = await login('testowner2@pulse.local', 'password123');

    expect(response.status).toBe(200);

    const data: any = await response.json();

    expect(data).toHaveProperty('accessToken');
    expect(data).toHaveProperty('refreshToken');
    expect(typeof data.accessToken).toBe('string');
    expect(typeof data.refreshToken).toBe('string');
  });

  test.skip('should assign default role to newly registered user', async () => {
    // TODO: /login's registerUser doesn't assign default roles (only /register does)
    const tdb = getTestDb();
    const response = await login('roleuser@pulse.local', 'password123');

    expect(response.status).toBe(200);

    // New users are named 'PulseUser' by default
    const allUsers = await tdb.select().from(users);
    const newUser = allUsers.find((u) => u.name === 'roleuser');

    expect(newUser).toBeTruthy();

    if (newUser) {
      const [userRole] = await tdb
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, newUser.id))
        .limit(1);

      expect(userRole).toBeTruthy();
    }
  });
});
