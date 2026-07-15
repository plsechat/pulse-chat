import { request, type APIRequestContext } from '@playwright/test';

export type TTestUser = {
  email: string;
  password: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
};

/**
 * Register a user through the real HTTP endpoint. The first user
 * registered on a fresh instance becomes the operator.
 */
export async function registerUser(
  baseURL: string,
  user: { email: string; password: string; displayName: string; invite?: string }
): Promise<TTestUser> {
  const ctx = await request.newContext({ baseURL });
  try {
    const res = await ctx.post('/register', { data: user });
    if (!res.ok()) {
      throw new Error(
        `register ${user.email} on ${baseURL} failed: ${res.status()} ${await res.text()}`
      );
    }
    const body = (await res.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    return { ...user, ...body };
  } finally {
    await ctx.dispose();
  }
}

export async function loginUser(
  baseURL: string,
  email: string,
  password: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const ctx = await request.newContext({ baseURL });
  try {
    const res = await ctx.post('/login', { data: { email, password } });
    if (!res.ok()) {
      throw new Error(
        `login ${email} on ${baseURL} failed: ${res.status()} ${await res.text()}`
      );
    }
    return (await res.json()) as { accessToken: string; refreshToken: string };
  } finally {
    await ctx.dispose();
  }
}

/**
 * Build a Playwright storageState that pre-authenticates a page: the
 * client (AUTH_BACKEND=local) reads its tokens from localStorage under
 * these keys on boot and goes straight to the app.
 */
export function storageStateFor(
  origin: string,
  tokens: { accessToken: string; refreshToken: string }
) {
  return {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          { name: 'pulse:auth:access_token', value: tokens.accessToken },
          { name: 'pulse:auth:refresh_token', value: tokens.refreshToken }
        ]
      }
    ]
  };
}

/** GET /info parsed. */
export async function fetchInfo(baseURL: string): Promise<Record<string, unknown>> {
  const ctx = await request.newContext({ baseURL });
  try {
    const res = await ctx.get('/info');
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await ctx.dispose();
  }
}

export { request as apiRequest };
export type { APIRequestContext };
