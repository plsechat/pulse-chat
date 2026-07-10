import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import { users } from '../../db/schema';
import { mintSessionToken, oidcSupabaseId } from '../../utils/oidc';

const AUTH_SECRET = 'test-oidc-secret-at-least-32-chars-long!!';

const provision = (token: string) =>
  fetch(`${testsBaseUrl}/auth/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({})
  });

describe('/auth/provision — OIDC session tokens', () => {
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = AUTH_SECRET;
  });

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = prevSecret;
  });

  test('rejects (401) a valid OIDC token whose user no longer exists — and does NOT create one', async () => {
    const supabaseId = oidcSupabaseId('ghost-subject');
    const token = await mintSessionToken(supabaseId);

    const res = await provision(token);
    expect(res.status).toBe(401);

    // Crucially, no placeholder account was created (the bug: `user-oidc:...`).
    const rows = await getTestDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.supabaseId, supabaseId));
    expect(rows.length).toBe(0);
  });

  test('succeeds (200) for an existing OIDC user', async () => {
    const supabaseId = oidcSupabaseId('known-subject');
    await getTestDb().insert(users).values({
      name: 'Known OIDC User',
      supabaseId,
      publicId: randomUUIDv7(),
      createdAt: Date.now()
    });

    const token = await mintSessionToken(supabaseId);

    const res = await provision(token);
    expect(res.status).toBe(200);
  });
});
